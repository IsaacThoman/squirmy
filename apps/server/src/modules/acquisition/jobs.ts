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
 *   job only. A provider that declines makes the job `rejected`.
 * - **queued → downloading**: the provider accepted; the first upload makes it downloading.
 *   Files stream into an import of kind `acquisition`.
 * - **importing**: the provider posted `complete`; the import is committed and
 *   `acquisition.finish` waits for it, then checks the delivery against the request
 *   (verify.ts).
 *
 * One job is in flight per recording or album: the `idempotency_key` is `recording:<id>` or
 * `album:<id>` while the job runs and gets the job id appended when it ends. Every status
 * change publishes `acquisition.updated`; the end of a job tells the playback sessions
 * (outcomes.ts). `acquisition.sweep` fails jobs past the policy's timeout, polls providers
 * that went quiet, and restarts the step a lost pg-boss job was doing, so nothing waits
 * forever after a restart.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { ProviderOffer, type AcquisitionJobStatus, type ProviderAlbumQuery } from '@squirmy/contracts'
import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionMisses, users } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { randomToken, hashToken } from '../../lib/crypto.js'
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { publish } from '../../realtime/index.js'
import { resolveOne } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { commitImport, createImport, failImport, getImport } from '../imports/index.js'
import { resolveImportRoot } from '../imports/service.js'
import { albumWithTracks, ownedRecordings } from './catalog.js'
import { acquire, jobStatus, ProviderCallError, resolveItems } from './client.js'
import { announceOutcome, stillWorking } from './outcomes.js'
import { acquiredBytes, deliveryUrls, getAcquisitionPolicy } from './policy.js'
import { activeProviders, noteProviderError, providerEndpoint, type ActiveProvider } from './providers.js'
import { expireCaches, freshOffers, invalidateRecordings, MISS_TTL_MS, recordMisses, resolveRecordings, usableOffers } from './resolve.js'
import { verifyDelivery } from './verify.js'

export type JobRow = typeof acquisitionJobs.$inferSelect
export type StartJob = { jobId: string }

/** Statuses in which the provider may still deliver files. */
export const DELIVERING: AcquisitionJobStatus[] = ['resolving', 'queued', 'downloading']

const timing = {
  /** How often `acquisition.finish` looks at the import. */
  pollMs: 1000,
  /** A job without uploads or completion for this long has its provider polled. */
  quietMs: 60_000,
  /** A job resolving this long without progress has its start job queued again. */
  stuckMs: 2 * 60_000,
  /** How long a job waiting for a free slot at its provider waits before trying again. */
  slotWaitSeconds: 5,
}

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
  if (job.requestedBy) await publish({ user: job.requestedBy }, event)
  await publish('admins', event)
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
  await announceOutcome({ ready, failed: notReady.filter((id) => !working.has(id)) })
  await invalidateRecordings([...ready, ...missed])
  await announce(row)
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

/**
 * Checks that a user may start a fetch and that there is somewhere to file it. Fails with
 * `acquire_not_allowed`, `not_available` (no active provider) or an import root error.
 */
async function checkRequest(userId: string): Promise<ActiveProvider[]> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  if (!user || user.disabledAt || !(user.canAcquire || user.role === 'admin')) {
    throw forbidden('Fetching music on demand is not enabled for your account', 'acquire_not_allowed')
  }
  const providers = await activeProviders()
  if (providers.length === 0) throw notFound('No acquisition provider is set up', 'not_available')
  await resolveImportRoot((await getAcquisitionPolicy()).targetRootId)
  return providers
}

/** Providers without a fresh miss for at least one of the recordings, in priority order. */
async function candidates(providers: readonly ActiveProvider[], recordingIds: readonly string[]): Promise<ActiveProvider[]> {
  const misses = await db.select({ providerId: acquisitionMisses.providerId, id: acquisitionMisses.entityId }).from(acquisitionMisses).where(and(
    eq(acquisitionMisses.entityType, 'recording'),
    sql`${acquisitionMisses.entityId} = any(${uuidArray(recordingIds)})`,
    gt(acquisitionMisses.createdAt, new Date(Date.now() - MISS_TTL_MS)),
  ))
  return providers.filter((provider) => recordingIds.some((id) => !misses.some((miss) => miss.providerId === provider.id && miss.id === id)))
}

type NewJob = { userId: string; providerId: string; recordingId: string | null; albumId: string | null; recordingIds: string[] }

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
        recordingIds: input.recordingIds, status: 'resolving', idempotencyKey: key,
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
    if (existing || attempt > 0) return existing!
  }
}

/** Fails with `storage_quota_reached` after recording a rejected job, when acquired files fill the quota. */
async function checkQuota(input: NewJob) {
  const { storageQuotaBytes } = await getAcquisitionPolicy()
  if (storageQuotaBytes === 0 || await acquiredBytes() < storageQuotaBytes) return
  const id = newId()
  await db.insert(acquisitionJobs).values({
    id, providerId: input.providerId, requestedBy: input.userId, recordingId: input.recordingId, albumId: input.albumId,
    recordingIds: input.recordingIds, status: 'rejected', error: 'The storage quota for acquired music is full',
    idempotencyKey: `quota:${id}`, completedAt: new Date(),
  })
  throw conflict('The storage quota for acquired music is full', 'storage_quota_reached')
}

/**
 * Starts fetching a recording for a user, or returns the job already fetching it. Fails with
 * `track_not_found`, `already_available`, `acquire_not_allowed`, `not_available` or
 * `storage_quota_reached`.
 */
export async function requestTrack(userId: string, recordingId: string, albumId: string | null): Promise<JobRow> {
  const target = await resolveOne('recordings', recordingId)
  if (!target) throw notFound('No such track', 'track_not_found')
  if ((await ownedRecordings([target])).size > 0) throw conflict('The server already has this track', 'already_available')
  const existing = await activeJobFor(target)
  if (existing) return existing
  const providers = await candidates(await checkRequest(userId), [target])
  if (providers.length === 0) throw notFound('No provider can supply this track right now', 'not_available')
  const album = albumId ? await resolveOne('albums', albumId) : null
  const input: NewJob = { userId, providerId: providers[0]!.id, recordingId: target, albumId: album, recordingIds: [target] }
  await checkQuota(input)
  return createJob(input)
}

/**
 * Starts fetching an album's missing tracks: one job when a provider takes albums whole,
 * else one per track (tracks no provider can supply are skipped). Fails like `requestTrack`.
 */
export async function requestAlbum(userId: string, albumId: string): Promise<JobRow[]> {
  const target = await resolveOne('albums', albumId)
  const found = target ? await albumWithTracks(target) : null
  if (!found) throw notFound('No such album', 'album_not_found')
  const missing = found.tracks.filter((track) => !track.owned).map((track) => track.recordingId)
  if (missing.length === 0) throw conflict('The server already has this album', 'already_available')
  const [existing] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.idempotencyKey, `album:${found.album.id}`))
  if (existing) return [existing]
  const providers = await candidates(await checkRequest(userId), missing)
  if (providers.length === 0) throw notFound('No provider can supply this album right now', 'not_available')
  const whole = providers.find((provider) => provider.capabilities.kinds.includes('album'))
  if (whole) {
    const input: NewJob = { userId, providerId: whole.id, recordingId: null, albumId: found.album.id, recordingIds: missing }
    await checkQuota(input)
    return [await createJob(input)]
  }
  const jobs: JobRow[] = []
  for (const recordingId of missing) {
    try {
      jobs.push(await requestTrack(userId, recordingId, found.album.id))
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'not_available') throw error
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

async function albumQuery(albumId: string): Promise<ProviderAlbumQuery | null> {
  const found = await albumWithTracks(albumId)
  if (!found) return null
  const { album, tracks } = found
  return {
    mbid: album.mbid, title: album.title, artist: album.artist, year: album.year, barcode: album.barcode,
    tracks: tracks.map((track) => ({
      disc: track.disc, position: track.position, title: track.title, durationMs: track.durationMs, recordingMbid: track.mbid, isrcs: track.isrcs,
    })),
  }
}

/** Asks providers in priority order for the job's offers; the first with a usable one wins. */
async function chooseProvider(job: JobRow): Promise<{ provider: ActiveProvider; offer: ProviderOffer } | { reason: string }> {
  const { preferLossless } = await getAcquisitionPolicy()
  const isAlbum = job.recordingId === null
  const providers = (await candidates(await activeProviders(), job.recordingIds))
    .filter((provider) => !isAlbum || provider.capabilities.kinds.includes('album'))
  let reason = 'No provider has a free offer for it'
  for (const provider of providers) {
    let offers: ProviderOffer[]
    try {
      if (isAlbum) {
        const album = await albumQuery(job.albumId!)
        if (!album) return { reason: 'The album no longer exists' }
        const response = await resolveItems(provider, { items: [{ ref: 'album', kind: 'album', album }] })
        offers = usableOffers(response.items.find((item) => item.ref === 'album')?.offers ?? [])
      } else {
        const recordingId = job.recordingId!
        offers = await freshOffers(provider.id, recordingId) ?? (await resolveRecordings(provider, [recordingId], job.albumId)).get(recordingId) ?? []
      }
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error
      await noteProviderError(provider.id, error.message)
      reason = `${provider.name}: ${error.message}`
      continue
    }
    const offer = chooseOffer(offers, preferLossless)
    if (offer) return { provider, offer }
  }
  return { reason }
}

/**
 * `acquisition.start`: picks an offer (once; it is kept on the job), waits for a slot at the
 * provider, and calls `POST /acquire` with a fresh job token. Only the token's hash is
 * stored. A run that finds the job past `resolving` does nothing, and a concurrent duplicate
 * loses the claim on the token.
 */
export async function startJob(jobId: string) {
  let job = await loadJob(jobId)
  if (!job || job.status !== 'resolving') return
  const providers = await activeProviders()
  let provider = job.offer ? providers.find((candidate) => candidate.id === job!.providerId) : undefined
  let offer = provider ? ProviderOffer.safeParse(job.offer).data : undefined
  if (!provider || !offer) {
    const choice = await chooseProvider(job)
    if ('reason' in choice) {
      await finishJob(jobId, { status: 'failed', error: choice.reason, missed: job.recordingId ? [] : job.recordingIds })
      return
    }
    ;({ provider, offer } = choice)
    job = await transition(jobId, ['resolving'], { providerId: provider.id, offer })
    if (!job) return
  }

  const [busy] = await db.select({ count: sql<number>`count(*)::int` }).from(acquisitionJobs)
    .where(and(eq(acquisitionJobs.providerId, provider.id), inArray(acquisitionJobs.status, ['queued', 'downloading'])))
  if ((busy?.count ?? 0) >= provider.capabilities.maxConcurrent) {
    await enqueue<StartJob>('acquisition.start', { jobId }, { singletonKey: `${jobId}:${Date.now()}`, startAfter: timing.slotWaitSeconds })
    return
  }

  const token = randomToken()
  const [claimed] = await db.update(acquisitionJobs).set({ uploadTokenHash: hashToken(token), updatedAt: new Date() }).where(and(
    eq(acquisitionJobs.id, jobId), eq(acquisitionJobs.status, 'resolving'),
    or(isNull(acquisitionJobs.uploadTokenHash), lt(acquisitionJobs.updatedAt, new Date(Date.now() - timing.stuckMs))),
  )).returning({ id: acquisitionJobs.id })
  if (!claimed) return

  let response
  try {
    response = await acquire(provider, { jobId, offerId: offer.offerId, delivery: { ...await deliveryUrls(jobId), token } })
  } catch (error) {
    if (!(error instanceof ProviderCallError)) throw error
    await noteProviderError(provider.id, error.message)
    await finishJob(jobId, { status: 'failed', error: `The provider could not start: ${error.message}`, missed: job.recordingIds })
    return
  }
  if (!response.accepted) {
    await finishJob(jobId, { status: 'rejected', error: `The provider declined: ${response.error ?? 'no reason given'}`, missed: job.recordingIds })
    return
  }
  if (response.providerJobId) {
    await db.update(acquisitionJobs).set({ providerJobId: response.providerJobId.slice(0, 500) }).where(eq(acquisitionJobs.id, jobId))
  }
  await transition(jobId, ['resolving'], { status: 'queued' })
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
 * `acquisition.finish`: waits for the job's import to end, then checks the delivery and
 * ends the job: `completed` when it satisfied at least one requested recording (the rest
 * get misses), `failed` otherwise. Files that did not match stay where the import left
 * them, with their provider source, and are never linked to the request.
 */
export async function finishDelivery(jobId: string) {
  for (;;) {
    const job = await loadJob(jobId)
    if (job?.status !== 'importing') return
    const done = job.importId ? await getImport(job.importId).catch(() => null) : null
    if (!done) {
      await finishJob(jobId, { status: 'failed', error: 'The import of the delivery is gone', missed: job.recordingIds })
      return
    }
    if (done.status === 'failed') {
      await finishJob(jobId, { status: 'failed', error: `The import failed: ${done.error ?? 'no reason given'}`, missed: job.recordingIds })
      return
    }
    if (done.status === 'completed') {
      const ready = await verifyDelivery(job)
      const unmatched = job.recordingIds.filter((id) => !ready.includes(id))
      if (ready.length === 0) {
        const error = done.counts.filesLeftForReview > 0
          ? 'The delivery was left for review and does not contain what was asked for'
          : 'The delivered files are not what was asked for'
        await finishJob(jobId, { status: 'failed', error, missed: job.recordingIds })
      } else {
        const error = unmatched.length > 0 ? `${unmatched.length} of ${job.recordingIds.length} tracks were not in the delivery` : null
        await finishJob(jobId, { status: 'completed', error, ready, missed: unmatched })
      }
      return
    }
    await sleep(timing.pollMs)
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
    await noteProviderError(provider.id, error.message)
    await touchJob(job.id)
    return
  }
  if (status.status === 'failed') await finishJob(job.id, { status: 'failed', error: `The provider failed: ${status.error ?? 'no reason given'}`, missed: job.recordingIds })
  else if (status.status === 'completed') await completeDelivery(job.id)
  else await touchJob(job.id)
}

/**
 * `acquisition.sweep` (every minute and at worker start): expires old misses and offers,
 * fails jobs whose provider has not delivered within the policy's timeout, polls providers
 * of jobs that went quiet, and re-queues the start or finish step of jobs whose pg-boss job
 * was lost in a restart.
 */
export async function sweepJobs(now = Date.now()) {
  await expireCaches(now)
  const { timeoutSeconds } = await getAcquisitionPolicy()
  const open = await db.select().from(acquisitionJobs).where(isNull(acquisitionJobs.completedAt))
  for (const job of open) {
    try {
      const status = job.status as AcquisitionJobStatus
      if (DELIVERING.includes(status) && job.createdAt.getTime() < now - timeoutSeconds * 1000) {
        await finishJob(job.id, { status: 'failed', error: `Nothing was delivered within ${timeoutSeconds} seconds`, missed: job.recordingIds })
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
}

/** What a job is for, in words: the track or album title. */
export async function jobTitle(job: Pick<JobRow, 'recordingId' | 'albumId'>): Promise<string> {
  const [row] = await db.execute<{ title: string }>(job.recordingId
    ? sql`select title || ' — ' || artist_credit as title from recordings where id = ${job.recordingId}`
    : sql`select title || ' — ' || artist_credit as title from albums where id = ${job.albumId}`)
  return row?.title ?? 'Unknown'
}
