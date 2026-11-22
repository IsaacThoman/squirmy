/**
 * The life cycle of an acquisition job:
 *
 *   resolving ─▶ queued ─▶ downloading ─▶ importing ─▶ completed
 *       │           │           │             └──────▶ failed
 *       └───────────┴───────────┴──▶ failed | rejected
 *
 * - **resolving**: `acquisition.start` asks the providers in priority order for offers
 *   (fresh cached ones first), picks one, waits for a free slot at the provider
 *   (`maxConcurrent`) and calls `POST /acquire` with the delivery URLs and a token for this
 *   job only. Jobs waiting for a slot take it by origin (`play`, then `prefetch`,
 *   `download`, `library`), oldest first within one. A provider that declines makes the
 *   job `rejected`; one that says it is busy (or is rate limited, at any step before files
 *   arrive) gets the job again later, with no miss and nothing counted against it.
 * - **queued → downloading**: the provider accepted; the first upload makes it downloading.
 *   Files stream into an import of kind `acquisition`.
 * - **importing**: the provider posted `complete`; the import is committed and
 *   `acquisition.finish` waits for it, then checks the delivery against the request
 *   (verify.ts). Files that are what was asked for are placed on the album they were
 *   requested from (place.ts) while the import runs, so the import files them.
 *
 * One job is in flight per recording or album: the `idempotency_key` is `recording:<id>` or
 * `album:<id>` while the job runs and gets the job id appended when it ends. Every status
 * change publishes `acquisition.updated`; the end of a job tells the playback sessions
 * (outcomes.ts). `acquisition.sweep` fails jobs past the policy's timeout, polls providers
 * that went quiet, and restarts the step a lost pg-boss job was doing, so nothing waits
 * forever after a restart.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { ProviderOffer, type AcquisitionJobStatus, type AcquisitionOrigin, type EntryFailure, type ProviderAlbumQuery } from '@squirmy/contracts'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, users } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { randomToken, hashToken } from '../../lib/crypto.js'
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { publish } from '../../realtime/index.js'
import { resolveMerged, resolveOne } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { commitImport, createImport, failImport, getImport, importCopies, refileImport } from '../imports/index.js'
import { resolveImportRoot } from '../imports/service.js'
import { albumWithTracks, ownedRecordings } from './catalog.js'
import { acquire, busyWaitSeconds, jobStatus, ProviderCallError, resolveItems, saysBusy } from './client.js'
import { announceOutcome, stillWorking } from './outcomes.js'
import { discardUnrequested, evictWhenOver } from './evict.js'
import { placeDelivery } from './place.js'
import { deliveryUrls, getAcquisitionPolicy } from './policy.js'
import { noteProviderDelivered, noteProviderFailure } from './health.js'
import { currentMisses } from './misses.js'
import { activeProviders, providerEndpoint, type ActiveProvider } from './providers.js'
import { repairDeliveries } from './repair.js'
import { expireCaches, freshOffers, invalidateRecordings, recordMisses, resolveRecordings, usableOffers } from './resolve.js'
import { verifyDelivery } from './verify.js'

export type JobRow = typeof acquisitionJobs.$inferSelect
/** `attempt` counts the times the provider said it was busy, for the backoff. */
export type StartJob = { jobId: string; attempt?: number }

/** Statuses in which the provider may still deliver files. */
export const DELIVERING: AcquisitionJobStatus[] = ['resolving', 'queued', 'downloading']

const timing = {
  /** How often `acquisition.finish` looks at the import; a usable file is announced this soon. */
  pollMs: 250,
  /** A job without uploads or completion for this long has its provider polled. */
  quietMs: 60_000,
  /** A job resolving this long without progress has its start job queued again. */
  stuckMs: 2 * 60_000,
  /** How long a job waiting for a free slot at its provider waits before trying again. */
  slotWaitSeconds: 5,
  /** The longest wait after a provider said it was busy; the waits double up to it. */
  busyWaitMaxSeconds: 60,
  /** How far back the sweep looks for deliveries that are not on their album yet. */
  recentMs: 2 * 60 * 60_000,
  /**
   * Unfinished jobs a member with `canAcquire` may have at once; admins have no limit.
   * Room for a long queue fetched ahead and a few albums fetched track by track, while a
   * script (or a stolen session) asking for every search result is stopped early.
   */
  memberJobLimit: 100,
}

/** Start order of waiting jobs: what is playing first, then what plays next, then the rest. */
const ORIGIN_RANK: Record<AcquisitionOrigin, number> = { play: 0, prefetch: 1, download: 2, library: 3 }
const originRank = (column: SQL | typeof acquisitionJobs.origin) =>
  sql`(case ${column} when 'play' then 0 when 'prefetch' then 1 when 'download' then 2 else 3 end)`

/** Overrides the job timings in tests. */
export function configureAcquisition(options: Partial<typeof timing>) {
  Object.assign(timing, options)
}

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

export async function loadJob(jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.id, jobId))
  return row ?? null
}

/** Sends `acquisition.updated` to whoever asked and to admins. */
async function announce(job: JobRow) {
  const event = { type: 'acquisition.updated' as const, jobId: job.id, trackId: job.recordingId, status: job.status }
  await publish(job.requestedBy ? [{ user: job.requestedBy }, 'admins'] : 'admins', event)
}

/** Updates a job that is in one of `from`, announcing a status change. Null when it was not. */
async function transition(jobId: string, from: AcquisitionJobStatus[], set: Partial<JobRow>): Promise<JobRow | null> {
  const [row] = await db.update(acquisitionJobs).set({ ...set, updatedAt: new Date() })
    .where(and(eq(acquisitionJobs.id, jobId), inArray(acquisitionJobs.status, from))).returning()
  if (row && set.status) await announce(row)
  return row ?? null
}

/** Marks a delivering job as still alive, so the sweep does not poll its provider. */
export async function touchJob(jobId: string) {
  await db.update(acquisitionJobs).set({ updatedAt: new Date() }).where(and(eq(acquisitionJobs.id, jobId), isNull(acquisitionJobs.completedAt)))
}

type Ending = {
  status: 'completed' | 'failed' | 'rejected'
  error?: string | null
  /** Requested recordings the delivery satisfied. */
  ready?: string[]
  /** Recordings the provider could not supply; they get a miss. */
  missed?: string[]
  /** The provider is failing (health.ts): sessions waiting on the job pause with a reason. */
  outage?: boolean
  /**
   * Why the recordings that are not ready failed, for the sessions waiting on them. Left
   * out: `outage` with `outage`, else `unavailable` for the missed ones (the provider does
   * not have them) and `error` for the rest.
   */
  cause?: EntryFailure
}

/**
 * Ends a job once: frees its idempotency key, fails an import still receiving, records
 * misses, and tells the sessions which recordings are ready and which failed (those not
 * ready, unless another job is still working on them).
 */
export async function finishJob(jobId: string, ending: Ending): Promise<JobRow | null> {
  const [row] = await db.update(acquisitionJobs).set({
    status: ending.status,
    error: ending.error?.slice(0, 1000) ?? null,
    completedAt: new Date(),
    updatedAt: new Date(),
    idempotencyKey: sql`${acquisitionJobs.idempotencyKey} || ':' || ${acquisitionJobs.id}`,
  }).where(and(eq(acquisitionJobs.id, jobId), isNull(acquisitionJobs.completedAt))).returning()
  if (!row) return null
  if (row.importId && ending.status !== 'completed') {
    await failImport(row.importId, ending.error ?? 'The acquisition ended').catch((error: unknown) => {
      if (!(error instanceof AppError)) throw error
    })
  }
  const ready = ending.ready ?? []
  const missed = ending.missed ?? []
  if (missed.length > 0) await recordMisses(db, row.providerId, 'recording', missed, ending.error ?? 'Not delivered')
  const notReady = row.recordingIds.filter((id) => !ready.includes(id))
  const working = await stillWorking(notReady, row.id)
  if (ending.status === 'completed' && ready.length > 0) await noteProviderDelivered(row.providerId)
  const failed = notReady.filter((id) => !working.has(id))
  const cause = ending.cause ?? (ending.outage ? 'outage' : null)
  if (cause) await announceOutcome({ ready, failed, cause })
  else {
    await announceOutcome({ ready, failed: failed.filter((id) => missed.includes(id)), cause: 'unavailable' })
    await announceOutcome({ failed: failed.filter((id) => !missed.includes(id)), cause: 'error' })
  }
  await invalidateRecordings([...ready, ...missed])
  await announce(row)
  // Its slot is free: the job first in line takes it now rather than at its next poll.
  await wakeWaiting(row.providerId).catch(report)
  if (ending.status === 'completed') await evictWhenOver().catch(report)
  return row
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The unfinished job covering a recording, if any. */
async function activeJobFor(recordingId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(acquisitionJobs)
    .where(and(isNull(acquisitionJobs.completedAt), sql`${acquisitionJobs.recordingIds} @> array[${recordingId}]::uuid[]`))
    .orderBy(acquisitionJobs.id).limit(1)
  return row ?? null
}

type Requester = { id: string; admin: boolean; providers: ActiveProvider[] }

/**
 * Checks that a user may start a fetch and that there is somewhere to file it. Fails with
 * `acquire_not_allowed`, `not_available` (no active provider) or an import root error.
 * Runs before anything about other users' jobs is looked at, so a member who may not fetch
 * learns nothing about who is fetching what.
 */
async function checkRequest(userId: string): Promise<Requester> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  if (!user || user.disabledAt || !(user.canAcquire || user.role === 'admin')) {
    throw forbidden('Fetching music on demand is not enabled for your account', 'acquire_not_allowed')
  }
  const providers = await activeProviders()
  if (providers.length === 0) throw notFound('No acquisition provider is set up', 'not_available')
  await resolveImportRoot((await getAcquisitionPolicy()).targetRootId)
  return { id: userId, admin: user.role === 'admin', providers }
}

/**
 * Fails with `acquire_limit_reached` (429) when a member already has `memberJobLimit`
 * unfinished jobs. Joining a job already in flight costs nothing and is never refused.
 */
async function checkJobLimit(requester: Requester) {
  if (requester.admin) return
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(acquisitionJobs)
    .where(and(eq(acquisitionJobs.requestedBy, requester.id), isNull(acquisitionJobs.completedAt)))
  if ((row?.count ?? 0) >= timing.memberJobLimit) {
    throw new AppError(429, 'acquire_limit_reached', 'Too many fetches are running for your account. Try again when some have finished.')
  }
}

/**
 * Moves an unfinished job up to `origin` when that starts sooner: pressing play on a track
 * that is being fetched for a library save makes it the next to start.
 */
async function promote(job: JobRow, origin: AcquisitionOrigin): Promise<JobRow> {
  if (ORIGIN_RANK[origin] >= ORIGIN_RANK[job.origin]) return job
  const [row] = await db.update(acquisitionJobs).set({ origin })
    .where(and(eq(acquisitionJobs.id, job.id), isNull(acquisitionJobs.completedAt), sql`${originRank(acquisitionJobs.origin)} > ${ORIGIN_RANK[origin]}`))
    .returning()
  return row ?? job
}

/** Providers without a miss that counts (misses.ts) for at least one of the recordings, in priority order. */
async function candidates(providers: readonly ActiveProvider[], recordingIds: readonly string[]): Promise<ActiveProvider[]> {
  const misses = await currentMisses(recordingIds)
  return providers.filter((provider) => recordingIds.some((id) => !misses.some((miss) => miss.providerId === provider.id && miss.id === id)))
}

type NewJob = { userId: string; providerId: string; recordingId: string | null; albumId: string | null; recordingIds: string[]; origin: AcquisitionOrigin }

/**
 * Inserts a job and queues its start in one transaction, or returns the job already in
 * flight for the same target.
 */
async function createJob(input: NewJob): Promise<JobRow> {
  const key = input.recordingId ? `recording:${input.recordingId}` : `album:${input.albumId}`
  for (let attempt = 0; ; attempt += 1) {
    const created = await db.transaction(async (tx) => {
      const id = newId()
      const [row] = await tx.insert(acquisitionJobs).values({
        id, providerId: input.providerId, requestedBy: input.userId, recordingId: input.recordingId, albumId: input.albumId,
        recordingIds: input.recordingIds, status: 'resolving', idempotencyKey: key, origin: input.origin,
      }).onConflictDoNothing({ target: acquisitionJobs.idempotencyKey }).returning()
      if (row) await enqueue<StartJob>('acquisition.start', { jobId: id }, { singletonKey: id, tx })
      return row
    })
    if (created) {
      await announce(created)
      return created
    }
    const [existing] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.idempotencyKey, key))
    // It finished between the insert and the read; one more try creates a new job.
    if (existing || attempt > 0) return existing ? promote(existing, input.origin) : existing!
  }
}

/**
 * Starts fetching a recording for a user, or returns the job already fetching it (moved up
 * to `origin` when that starts sooner). `origin` defaults to `library`, an explicit request;
 * playback passes `play` or `prefetch`. The cache limit never refuses a request: delivered
 * files beyond it are evicted (evict.ts). Fails with `track_not_found`, `already_available`,
 * `acquire_not_allowed`, `not_available` or `acquire_limit_reached`.
 */
export async function requestTrack(userId: string, recordingId: string, albumId: string | null, origin: AcquisitionOrigin = 'library'): Promise<JobRow> {
  const target = await resolveOne('recordings', recordingId)
  if (!target) throw notFound('No such track', 'track_not_found')
  if ((await ownedRecordings([target])).size > 0) throw conflict('The server already has this track', 'already_available')
  const requester = await checkRequest(userId)
  const existing = await activeJobFor(target)
  if (existing) return promote(existing, origin)
  await checkJobLimit(requester)
  const providers = await candidates(requester.providers, [target])
  if (providers.length === 0) throw notFound('No provider can supply this track right now', 'not_available')
  const album = albumId ? await resolveOne('albums', albumId) : null
  return createJob({ userId, providerId: providers[0]!.id, recordingId: target, albumId: album, recordingIds: [target], origin })
}

/**
 * Starts fetching an album's missing tracks: one job when a provider takes albums whole,
 * else one per track (tracks no provider can supply are skipped). Tracks another job is
 * already fetching are left out, so playing an album and then saving it does not fetch the
 * playing tracks twice. Fails like `requestTrack`; a member who reaches the job limit part
 * way through keeps the jobs already made.
 */
export async function requestAlbum(userId: string, albumId: string, origin: AcquisitionOrigin = 'library'): Promise<JobRow[]> {
  const target = await resolveOne('albums', albumId)
  const found = target ? await albumWithTracks(target) : null
  if (!found) throw notFound('No such album', 'album_not_found')
  const unowned = found.tracks.filter((track) => !track.owned).map((track) => track.recordingId)
  if (unowned.length === 0) throw conflict('The server already has this album', 'already_available')
  const requester = await checkRequest(userId)
  const [existing] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.idempotencyKey, `album:${found.album.id}`))
  if (existing) return [await promote(existing, origin)]
  const inFlight = await stillWorking(unowned)
  const missing = unowned.filter((id) => !inFlight.has(id))
  if (missing.length === 0) {
    return db.select().from(acquisitionJobs).where(and(isNull(acquisitionJobs.completedAt), sql`${acquisitionJobs.recordingIds} && ${uuidArray(unowned)}`))
      .orderBy(acquisitionJobs.id)
  }
  const providers = await candidates(requester.providers, missing)
  if (providers.length === 0) throw notFound('No provider can supply this album right now', 'not_available')
  await checkJobLimit(requester)
  const whole = providers.find((provider) => provider.capabilities.kinds.includes('album'))
  if (whole) return [await createJob({ userId, providerId: whole.id, recordingId: null, albumId: found.album.id, recordingIds: missing, origin })]
  const jobs: JobRow[] = []
  for (const recordingId of missing) {
    try {
      jobs.push(await requestTrack(userId, recordingId, found.album.id, origin))
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      if (error.code === 'acquire_limit_reached' && jobs.length > 0) break
      if (error.code !== 'not_available') throw error
    }
  }
  if (jobs.length === 0) throw notFound('No provider can supply this album right now', 'not_available')
  return jobs
}

// ---------------------------------------------------------------------------
// Starting: choosing an offer and handing it to the provider
// ---------------------------------------------------------------------------

/**
 * The offer to take: priced and expired offers never; then lossless first when the policy
 * prefers it (lossy first otherwise, to keep files small); then the highest quality
 * (sample rate × bit depth for lossless, bitrate for lossy).
 */
export function chooseOffer(offers: readonly ProviderOffer[], preferLossless: boolean): ProviderOffer | null {
  const quality = (offer: ProviderOffer) => offer.lossless ? (offer.sampleRate ?? 44_100) * (offer.bitDepth ?? 16) : offer.bitrate ?? 0
  const ranked = usableOffers(offers).sort((a, b) =>
    (a.lossless === b.lossless ? 0 : (a.lossless === preferLossless ? -1 : 1)) || quality(b) - quality(a))
  return ranked[0] ?? null
}

/**
 * The album as a provider is asked for it: the whole track list, so it can tell the edition
 * apart, with the tracks the job does not need (the server has them, or another job is
 * fetching them) marked `wanted: false`.
 */
async function albumQuery(albumId: string, recordingIds: readonly string[]): Promise<ProviderAlbumQuery | null> {
  const found = await albumWithTracks(albumId)
  if (!found) return null
  const { album, tracks } = found
  const resolved = await resolveMerged('recordings', recordingIds)
  const needed = new Set(recordingIds.map((id) => resolved.get(id) ?? id))
  return {
    mbid: album.mbid, title: album.title, artist: album.artist, year: album.year, barcode: album.barcode,
    tracks: tracks.map((track) => ({
      disc: track.disc, position: track.position, title: track.title, durationMs: track.durationMs, recordingMbid: track.mbid, isrcs: track.isrcs,
      ...(track.owned || !needed.has(track.recordingId) ? { wanted: false } : {}),
    })),
  }
}

type NoChoice = {
  reason: string
  outage?: boolean
  /** `unavailable`: every provider asked answered without an offer; `outage`: one could not be asked. */
  cause?: EntryFailure
  /** A provider was too busy to answer and none had an offer: ask again later. */
  busy?: { retryAfterSeconds: number | null }
}

/**
 * Asks providers in priority order for the job's offers; the first with a usable one wins.
 * A provider too busy to answer is skipped without counting against it; when no other has
 * an offer, the job waits for it (`busy`) rather than failing.
 */
async function chooseProvider(job: JobRow): Promise<{ provider: ActiveProvider; offer: ProviderOffer } | NoChoice> {
  const { preferLossless } = await getAcquisitionPolicy()
  const isAlbum = job.recordingId === null
  const providers = (await candidates(await activeProviders(), job.recordingIds))
    .filter((provider) => !isAlbum || provider.capabilities.kinds.includes('album'))
  let reason = 'No provider has a free offer for it'
  let outage = false
  let unreachable = false
  let busy: NoChoice['busy']
  for (const provider of providers) {
    let offers: ProviderOffer[]
    try {
      if (isAlbum) {
        const album = await albumQuery(job.albumId!, job.recordingIds)
        if (!album) return { reason: 'The album no longer exists' }
        const response = await resolveItems(provider, { items: [{ ref: 'album', kind: 'album', album }] })
        offers = usableOffers(response.items.find((item) => item.ref === 'album')?.offers ?? [])
      } else {
        const recordingId = job.recordingId!
        offers = await freshOffers(provider.id, recordingId) ?? (await resolveRecordings(provider, [recordingId], job.albumId)).get(recordingId) ?? []
      }
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error
      if (error.busy) {
        busy = { retryAfterSeconds: Math.max(busy?.retryAfterSeconds ?? 0, error.retryAfterSeconds ?? 0) || null }
        continue
      }
      outage = await noteProviderFailure(provider.id, error.message, job.recordingIds)
      unreachable = true
      reason = `${provider.name}: ${error.message}`
      continue
    }
    const offer = chooseOffer(offers, preferLossless)
    if (offer) return { provider, offer }
    outage = false
  }
  // A provider that could not be asked may have it: the listener is told fetching is down
  // rather than that the song is missing.
  return { reason, outage, busy, cause: outage || unreachable ? 'outage' : 'unavailable' }
}

/**
 * `acquisition.start`: picks an offer (once; it is kept on the job), waits for a slot at the
 * provider, and calls `POST /acquire` with a fresh job token. Only the token's hash is
 * stored. A run that finds the job past `resolving` does nothing, and a concurrent duplicate
 * loses the claim on the token.
 */
export async function startJob(jobId: string, attempt = 0) {
  let job = await loadJob(jobId)
  if (!job || job.status !== 'resolving') return
  const providers = await activeProviders()
  let provider = job.offer ? providers.find((candidate) => candidate.id === job!.providerId) : undefined
  let offer = provider ? ProviderOffer.safeParse(job.offer).data : undefined
  if (!provider || !offer) {
    const choice = await chooseProvider(job)
    if ('reason' in choice && choice.busy) {
      await retryWhenFree(jobId, attempt, choice.busy.retryAfterSeconds)
      return
    }
    if ('reason' in choice) {
      if (job.recordingId === null) await fetchTracksInstead(job, choice.reason)
      else await finishJob(jobId, { status: 'failed', error: choice.reason, outage: choice.outage, cause: choice.cause })
      return
    }
    ;({ provider, offer } = choice)
    job = await transition(jobId, ['resolving'], { providerId: provider.id, offer })
    if (!job) return
  }

  const token = randomToken()
  const claim = await claimSlot(job, provider, token)
  if (claim === 'full') {
    await enqueue<StartJob>('acquisition.start', { jobId, attempt }, { singletonKey: `${jobId}:${Date.now()}`, startAfter: timing.slotWaitSeconds })
    return
  }
  if (claim === 'taken') return

  let response
  try {
    response = await acquire(provider, { jobId, offerId: offer.offerId, delivery: { ...await deliveryUrls(jobId), token } })
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw error
    if (error.busy) {
      await retryWhenFree(jobId, attempt, error.retryAfterSeconds)
      return
    }
    const outage = await noteProviderFailure(provider.id, error.message, job.recordingIds)
    // It could not be reached or refused the call: the tracks are not what is known to be wrong.
    await finishJob(jobId, { status: 'failed', error: `The provider could not start: ${error.message}`, missed: outage ? [] : job.recordingIds, outage, cause: 'outage' })
    return
  }
  if (!response.accepted) {
    if (saysBusy(response)) {
      await retryWhenFree(jobId, attempt)
      return
    }
    const error = `The provider declined: ${response.error ?? 'no reason given'}`
    if (job.recordingId === null) await fetchTracksInstead(job, error)
    else await finishJob(jobId, { status: 'rejected', error, missed: job.recordingIds })
    return
  }
  if (response.providerJobId) {
    await db.update(acquisitionJobs).set({ providerJobId: response.providerJobId.slice(0, 500) }).where(eq(acquisitionJobs.id, jobId))
  }
  await transition(jobId, ['resolving'], { status: 'queued' })
}

/** Jobs that chose this provider and wait for a slot at it: no claim, or a claim gone stale. */
function waitingAt(providerId: string, stale: Date): SQL {
  return and(
    eq(acquisitionJobs.providerId, providerId), eq(acquisitionJobs.status, 'resolving'), isNotNull(acquisitionJobs.offer),
    or(isNull(acquisitionJobs.uploadTokenHash), lt(acquisitionJobs.updatedAt, stale)),
  )!
}

/**
 * Takes one of the provider's `maxConcurrent` slots for the job by storing its token's hash.
 * Counting and claiming happen under a lock per provider, so jobs starting at the same time
 * cannot all see a free slot and overshoot: the provider would decline the extra ones. A
 * job that claimed a slot and is still waiting for the provider's answer holds it too.
 * Free slots go to waiting jobs in start order (`ORIGIN_RANK`, then oldest): a job leaves
 * a slot to the waiting jobs ahead of it, so a prefetch or a library save created earlier
 * never takes the slot the playing track needs. `taken`: another run of this start claimed
 * the job first.
 */
async function claimSlot(job: JobRow, provider: ActiveProvider, token: string): Promise<'claimed' | 'full' | 'taken'> {
  const stale = new Date(Date.now() - timing.stuckMs)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`squirmy.acquisition.slot:${provider.id}`}))`)
    const [busy] = await tx.select({ count: sql<number>`count(*)::int` }).from(acquisitionJobs).where(and(
      eq(acquisitionJobs.providerId, provider.id),
      sql`${acquisitionJobs.id} <> ${job.id}`,
      or(
        inArray(acquisitionJobs.status, ['queued', 'downloading']),
        and(eq(acquisitionJobs.status, 'resolving'), sql`${acquisitionJobs.uploadTokenHash} is not null`, gt(acquisitionJobs.updatedAt, stale)),
      ),
    ))
    const rank = ORIGIN_RANK[job.origin]
    const [ahead] = await tx.select({ count: sql<number>`count(*)::int` }).from(acquisitionJobs).where(and(
      waitingAt(provider.id, stale),
      sql`${acquisitionJobs.id} <> ${job.id}`,
      sql`(${originRank(acquisitionJobs.origin)} < ${rank} or (${originRank(acquisitionJobs.origin)} = ${rank} and ${acquisitionJobs.id} < ${job.id}))`,
    ))
    if ((busy?.count ?? 0) + (ahead?.count ?? 0) >= provider.capabilities.maxConcurrent) return 'full'
    const [claimed] = await tx.update(acquisitionJobs).set({ uploadTokenHash: hashToken(token), updatedAt: new Date() }).where(and(
      eq(acquisitionJobs.id, job.id), eq(acquisitionJobs.status, 'resolving'),
      or(isNull(acquisitionJobs.uploadTokenHash), lt(acquisitionJobs.updatedAt, stale)),
    )).returning({ id: acquisitionJobs.id })
    return claimed ? 'claimed' : 'taken'
  })
}

/**
 * Queues the start of the jobs first in line at a provider, so a freed slot is taken at
 * once instead of at the next poll. Each still checks its place in line (`claimSlot`).
 */
async function wakeWaiting(providerId: string) {
  const provider = (await activeProviders()).find((candidate) => candidate.id === providerId)
  if (!provider) return
  const next = await db.select({ id: acquisitionJobs.id }).from(acquisitionJobs)
    .where(waitingAt(providerId, new Date(Date.now() - timing.stuckMs)))
    .orderBy(originRank(acquisitionJobs.origin), asc(acquisitionJobs.id)).limit(provider.capabilities.maxConcurrent)
  for (const row of next) await enqueue<StartJob>('acquisition.start', { jobId: row.id }, { singletonKey: row.id })
}

/**
 * Gives the job's slot back and asks again later, waiting twice as long each time up to
 * `busyWaitMaxSeconds`, or as long as the provider asked (`Retry-After`). No miss is
 * recorded and nothing counts against the provider's health: it did not say it lacks the
 * tracks, and a miss would gray them out for a day. A job the provider never takes ends at
 * the policy's timeout, also without a miss.
 */
async function retryWhenFree(jobId: string, attempt: number, retryAfterSeconds: number | null = null) {
  await db.update(acquisitionJobs).set({ uploadTokenHash: null, updatedAt: new Date() })
    .where(and(eq(acquisitionJobs.id, jobId), eq(acquisitionJobs.status, 'resolving')))
  const wait = busyWaitSeconds(attempt, retryAfterSeconds, { firstSeconds: timing.slotWaitSeconds, maxSeconds: timing.busyWaitMaxSeconds })
  await enqueue<StartJob>('acquisition.start', { jobId, attempt: attempt + 1 }, { singletonKey: `${jobId}:${Date.now()}`, startAfter: wait })
}

/**
 * A provider that took a job and then gave it up as busy (its source rate limited it).
 * Before any file arrived, the job goes back to waiting and is handed over again later,
 * keeping its offer. The attempt count is not kept on the job, so the wait is its age:
 * each wait about doubles it. With files already in, it fails, but without misses.
 */
async function busyAfterAccepting(job: JobRow, error: string) {
  if (!job.importId) {
    const waiting = await transition(job.id, ['queued'], { status: 'resolving', providerJobId: null, uploadTokenHash: null, error: error.slice(0, 1000) })
    if (waiting) {
      const ageSeconds = Math.ceil((Date.now() - job.createdAt.getTime()) / 1000)
      const wait = Math.min(timing.busyWaitMaxSeconds, Math.max(timing.slotWaitSeconds, ageSeconds))
      await enqueue<StartJob>('acquisition.start', { jobId: job.id }, { singletonKey: `${job.id}:${Date.now()}`, startAfter: wait })
      await wakeWaiting(job.providerId).catch(report)
      return
    }
  }
  await finishJob(job.id, { status: 'failed', error })
}

/**
 * Ends a job the provider gave up on. A busy failure (`reason: "busy"` or rate-limit
 * wording) is not the end: see `busyAfterAccepting`. An album job that delivered nothing is
 * fetched track by track instead (see `fetchTracksInstead`); anything else fails with
 * misses, unless the provider is failing (health.ts): then the tracks are not what is wrong.
 */
export async function providerFailed(job: JobRow, error: string, answer: { reason?: string | null; error?: string | null } = {}) {
  if (saysBusy(answer)) {
    await busyAfterAccepting(job, error)
    return
  }
  const outage = await noteProviderFailure(job.providerId, error, job.recordingIds)
  if (job.recordingId === null && !job.importId) await fetchTracksInstead(job, error)
  else await finishJob(job.id, { status: 'failed', error, missed: outage ? [] : job.recordingIds, outage })
}

/**
 * An album no provider will fetch whole: the job ends without misses and each of its
 * tracks the server still lacks is asked for on its own, as playing them would. Tracks no
 * provider can supply are skipped; they get their misses from their own resolve.
 */
async function fetchTracksInstead(job: JobRow, reason: string) {
  if (!job.requestedBy) {
    await finishJob(job.id, { status: 'failed', error: reason, missed: job.recordingIds })
    return
  }
  const ended = await finishJob(job.id, { status: 'failed', error: `${reason}; fetching its tracks one at a time` })
  if (!ended) return
  const owned = await ownedRecordings(job.recordingIds)
  for (const recordingId of job.recordingIds.filter((id) => !owned.has(id))) {
    try {
      await requestTrack(job.requestedBy, recordingId, job.albumId, job.origin)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Delivery and import
// ---------------------------------------------------------------------------

/**
 * The job's import, created on its first upload. Two uploads racing create one import each
 * and keep the one recorded first. When no import can be created (the target root is gone)
 * the job fails.
 */
export async function ensureImport(job: JobRow): Promise<string> {
  if (job.importId) return job.importId
  const { targetRootId } = await getAcquisitionPolicy()
  const label = await jobTitle(job)
  let created
  try {
    created = await createImport({ kind: 'acquisition', userId: job.requestedBy, acquisitionJobId: job.id, label, rootId: targetRootId })
  } catch (error) {
    // No root to file into any more: nothing this provider sends can land.
    if (error instanceof AppError) await finishJob(job.id, { status: 'failed', error: error.message })
    throw error
  }
  const [won] = await db.update(acquisitionJobs).set({ importId: created.id, updatedAt: new Date() })
    .where(and(eq(acquisitionJobs.id, job.id), isNull(acquisitionJobs.importId))).returning({ importId: acquisitionJobs.importId })
  if (won) return created.id
  await failImport(created.id, 'Superseded by another upload of the same delivery')
  return (await loadJob(job.id))!.importId!
}

/** The first upload moves a job to `downloading`. */
export async function markDownloading(jobId: string) {
  await transition(jobId, ['resolving', 'queued'], { status: 'downloading' })
}

/**
 * The provider says it delivered everything: commits the import and queues
 * `acquisition.finish`. A delivery with no accepted file fails the job.
 */
export async function completeDelivery(jobId: string) {
  const job = await loadJob(jobId)
  if (!job || !DELIVERING.includes(job.status as AcquisitionJobStatus)) return
  const received = job.importId ? await getImport(job.importId) : null
  if (!received || (received.status === 'receiving' && received.counts.filesReceived === 0)) {
    await finishJob(jobId, { status: 'failed', error: 'The provider finished without delivering a usable file', missed: job.recordingIds })
    return
  }
  if (received.status === 'receiving') {
    await commitImport(received.id).catch((error: unknown) => {
      if (!(error instanceof AppError && error.code === 'import_not_receiving')) throw error
    })
  }
  await transition(jobId, DELIVERING, { status: 'importing' })
  await enqueue<StartJob>('acquisition.finish', { jobId }, { singletonKey: jobId })
}

/**
 * `acquisition.finish`: follows the job's import. While it identifies, delivered files
 * that are already usable are checked (verify.ts, `early`) and the recordings they satisfy
 * are announced ready, so playback starts without waiting for matching and filing; a
 * delivery of one file is also placed on its album then (place.ts), and any other when the
 * import settles it (delivery.ts). Once the import ends, the delivery is checked again and
 * the job ends: `completed` when it satisfied at least one requested recording (the rest
 * get misses), `failed` otherwise. What could not be placed while the import ran is placed
 * then and filed. Delivered files that are not a requested recording are deleted
 * (`discardUnrequested`): a delivery is never left for review.
 *
 * A recording announced early that the final check no longer finds (matching linked its
 * file to a recording with another MusicBrainz id) fails like any other: it gets a miss and
 * its entries are marked failed, which skips them in future. Its file is deleted with the
 * rest of what was not asked for, so a current entry already playing it stops when the
 * device next reads the stream and is skipped.
 */
export async function finishDelivery(jobId: string) {
  const announced = new Set<string>()
  const seen = new Set<string>()
  for (;;) {
    const job = await loadJob(jobId)
    if (job?.status !== 'importing') return
    const done = job.importId ? await getImport(job.importId).catch(() => null) : null
    if (!done) {
      await finishJob(jobId, { status: 'failed', error: 'The import of the delivery is gone', missed: job.recordingIds, cause: 'error' })
      return
    }
    if (done.status === 'failed') {
      // This server's import, not the provider, failed.
      await finishJob(jobId, { status: 'failed', error: `The import failed: ${done.error ?? 'no reason given'}`, missed: job.recordingIds, cause: 'error' })
      await discardUnrequested(job).catch(report)
      return
    }
    if (done.status === 'completed') {
      const ready = await verifyDelivery(job, { copies: await importCopies(job.importId!) })
      const unmatched = job.recordingIds.filter((id) => !ready.includes(id))
      const revoked = unmatched.filter((id) => announced.has(id)).length
      if (ready.length === 0) {
        // Ready is announced for prefetches too, so nothing may have played it yet.
        const error = revoked > 0
          ? 'Identification found the delivery is a different recording after it was reported ready'
          : 'The delivered files are not what was asked for'
        await finishJob(jobId, { status: 'failed', error, missed: job.recordingIds })
      } else {
        const error = unmatched.length > 0 ? `${unmatched.length} of ${job.recordingIds.length} tracks were not in the delivery` : null
        await finishJob(jobId, { status: 'completed', error, ready, missed: unmatched })
        await placeLate(job)
      }
      await discardUnrequested(job).catch(report)
      return
    }
    const early = (await verifyDelivery(job, { early: true })).filter((id) => !announced.has(id))
    if (early.length > 0) {
      for (const id of early) announced.add(id)
      await announceOutcome({ ready: early })
      await invalidateRecordings(early)
    }
    // After the announcement: placing may wait a few seconds for the album's track list.
    await placeDelivery(job, { early: true, seen }).catch(report)
    await sleep(timing.pollMs)
  }
}

/**
 * Places what the import finished without placing (its album's track list arrived late, or
 * the import ran out of time) and files it. The job has ended, so a failure here is only
 * reported; the repair looks at the delivery again.
 */
async function placeLate(job: JobRow) {
  try {
    const { placed } = await placeDelivery(job)
    if (placed.length > 0 && job.importId) await refileImport(job.importId)
  } catch (error) {
    report(error)
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Asks the provider about a job that went quiet and acts on the answer. */
async function pollProvider(job: JobRow) {
  const provider = await providerEndpoint(job.providerId)
  let status
  try {
    status = await jobStatus(provider, job.providerJobId!)
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw error
    if (!error.busy) await noteProviderFailure(provider.id, error.message, job.recordingIds)
    await touchJob(job.id)
    return
  }
  if (status.status === 'failed') await providerFailed(job, `The provider failed: ${status.error ?? 'no reason given'}`, status)
  else if (status.status === 'completed') await completeDelivery(job.id)
  else await touchJob(job.id)
}

/**
 * `acquisition.sweep` (every minute and at worker start): expires old misses and offers,
 * fails jobs whose provider has not delivered within the policy's timeout, polls providers
 * of jobs that went quiet, and re-queues the start or finish step of jobs whose pg-boss job
 * was lost in a restart. Then it looks again at recent deliveries that are not yet on their
 * album (repair.ts): those that were waiting for the album's track list, and deletes what
 * recently ended jobs' imports brought that was not asked for.
 */
export async function sweepJobs(now = Date.now()) {
  await expireCaches(now)
  const { timeoutSeconds } = await getAcquisitionPolicy()
  const open = await db.select().from(acquisitionJobs).where(isNull(acquisitionJobs.completedAt))
  for (const job of open) {
    try {
      const status = job.status as AcquisitionJobStatus
      if (DELIVERING.includes(status) && job.createdAt.getTime() < now - timeoutSeconds * 1000) {
        // A job the provider never took (it kept saying it was busy) is no sign it lacks the tracks.
        const error = `Nothing was delivered within ${timeoutSeconds} seconds`
        const outage = status !== 'resolving' && await noteProviderFailure(job.providerId, error, job.recordingIds)
        const missed = status === 'resolving' || outage ? [] : job.recordingIds
        // Nothing came, for no reason anyone gave: unknown, unless the provider is failing.
        await finishJob(job.id, { status: 'failed', error, missed, outage, cause: outage ? 'outage' : 'error' })
      } else if (status === 'importing') {
        await enqueue<StartJob>('acquisition.finish', { jobId: job.id }, { singletonKey: job.id })
      } else if (status === 'resolving') {
        if (job.updatedAt.getTime() < now - timing.stuckMs) await enqueue<StartJob>('acquisition.start', { jobId: job.id }, { singletonKey: job.id })
      } else if (job.providerJobId && job.updatedAt.getTime() < now - timing.quietMs) {
        await pollProvider(job)
      }
    } catch (error) {
      report(error)
    }
  }
  await repairDeliveries({ since: new Date(now - timing.recentMs), limit: 50, budgetMs: 20_000 }).catch(report)
  // Jobs that ended while their import was still running: what it filed after that and was
  // not asked for goes too.
  const ended = await db.select().from(acquisitionJobs).where(and(
    isNotNull(acquisitionJobs.importId), gt(acquisitionJobs.completedAt, new Date(now - timing.recentMs)),
  )).orderBy(asc(acquisitionJobs.completedAt)).limit(100)
  for (const job of ended) await discardUnrequested(job).catch(report)
}

/** What a job is for, in words: the track or album title. */
export async function jobTitle(job: Pick<JobRow, 'recordingId' | 'albumId'>): Promise<string> {
  const [row] = await db.execute<{ title: string }>(job.recordingId
    ? sql`select title || ' — ' || artist_credit as title from recordings where id = ${job.recordingId}`
    : sql`select title || ' — ' || artist_credit as title from albums where id = ${job.albumId}`)
  return row?.title ?? 'Unknown'
}
