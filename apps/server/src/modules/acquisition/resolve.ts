/**
 * What providers can supply, and the caches that answer it without asking them.
 *
 * - `acquisition_offers` holds the free offers a provider returned for a recording (the
 *   positive cache). A `must_resolve` provider covers exactly the recordings it has a
 *   recent row for.
 * - `acquisition_misses` holds what a provider could not supply: an empty resolve, a failed
 *   or mismatched delivery. A miss hides the recording from that provider for a day, then
 *   it is asked again; sooner when the provider changes (misses.ts).
 * - Recordings a `must_resolve` provider has never answered for are batched into
 *   `acquisition.resolve` jobs, and the screens showing them are invalidated when the
 *   answer arrives.
 */
import { type ProviderOffer, type ProviderRecordingQuery } from '@squirmy/contracts'
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionMisses, acquisitionOffers } from '../../database/schema.js'
import { enqueue, enqueueMany } from '../../jobs/index.js'
import { publishChanges } from '../../realtime/index.js'
import { albumAvailability, trackAvailability } from '../catalog/availability.js'
import { uuidArray } from '../catalog/sql.js'
import { busyWaitSeconds, ProviderCallError, resolveItems, type ProviderEndpoint } from './client.js'
import { currentMisses, expireMisses, recordMisses } from './misses.js'
import { activeProviders, noteProviderError, type ActiveProvider } from './providers.js'

export { MISS_TTL_MS, recordMisses } from './misses.js'
/** A positive resolve counts for coverage this long. */
export const OFFER_TTL_MS = 30 * 24 * 60 * 60_000
/** Offers younger than this are acquired without resolving again. */
export const FRESH_OFFER_MS = 60 * 60_000
/** Items per `POST /resolve`, the protocol's limit. */
export const RESOLVE_BATCH = 100

const timing = {
  debounceMs: 250,
  reaskMs: 10 * 60_000,
  /** A resolve the provider was too busy for is asked again after this, doubling, a few times. */
  busyWaitSeconds: 5,
  busyRetries: 5,
}
const pending = new Map<string, Set<string>>()
/** `<provider>:<recording>` → when a resolve was last queued for it, so lists do not queue it again. */
const asked = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Overrides the resolve batching delays in tests. */
export function configureResolve(options: Partial<typeof timing>) {
  Object.assign(timing, options)
}

/** Free offers that have not expired: priced offers are ignored by this version of the server. */
export function usableOffers(offers: readonly ProviderOffer[], now = Date.now()): ProviderOffer[] {
  return offers.filter((offer) => offer.price == null && (!offer.expiresAt || Date.parse(offer.expiresAt) > now))
}

/**
 * Of the given unowned recordings, those some active provider covers: every one without a
 * recent miss for an `assume_available` provider, those with a recent positive resolve for
 * a `must_resolve` provider. Recordings a `must_resolve` provider has not answered for yet
 * are queued for resolving.
 */
export async function coveredRecordings(providers: readonly ActiveProvider[], ids: readonly string[]): Promise<Set<string>> {
  const mustResolve = providers.filter((provider) => provider.coverage === 'must_resolve')
  const now = Date.now()
  const [misses, offers] = await Promise.all([
    currentMisses(ids),
    mustResolve.length === 0 ? [] : db.select({ providerId: acquisitionOffers.providerId, id: acquisitionOffers.recordingId }).from(acquisitionOffers).where(and(
      sql`${acquisitionOffers.recordingId} = any(${uuidArray(ids)})`,
      inArray(acquisitionOffers.providerId, mustResolve.map((provider) => provider.id)),
      gt(acquisitionOffers.resolvedAt, new Date(now - OFFER_TTL_MS)),
    )),
  ])
  const missed = new Set(misses.map((row) => `${row.providerId}:${row.id}`))
  const offered = new Set(offers.map((row) => `${row.providerId}:${row.id}`))
  const covered = new Set<string>()
  for (const provider of providers) {
    const unresolved: string[] = []
    for (const id of ids) {
      const key = `${provider.id}:${id}`
      if (missed.has(key)) continue
      if (provider.coverage === 'assume_available' || offered.has(key)) covered.add(id)
      else unresolved.push(id)
    }
    if (unresolved.length > 0) scheduleResolve(provider.id, unresolved)
  }
  return covered
}

/** Queues recordings for a batched `acquisition.resolve`, at most once per provider every few minutes. */
function scheduleResolve(providerId: string, ids: readonly string[]) {
  const now = Date.now()
  let batch = pending.get(providerId)
  for (const id of ids) {
    const key = `${providerId}:${id}`
    if (now - (asked.get(key) ?? -Infinity) < timing.reaskMs) continue
    asked.set(key, now)
    if (!batch) pending.set(providerId, batch = new Set())
    batch.add(id)
  }
  if (batch && !flushTimer) {
    flushTimer = setTimeout(() => void flushResolves(), timing.debounceMs)
    flushTimer.unref()
  }
}

/** Enqueues what `scheduleResolve` collected, in batches of the protocol's size. */
export async function flushResolves() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  const now = Date.now()
  for (const [key, at] of asked) if (now - at >= timing.reaskMs) asked.delete(key)
  const items: { data: ResolveJob }[] = []
  for (const [providerId, ids] of pending) {
    const list = [...ids]
    for (let start = 0; start < list.length; start += RESOLVE_BATCH) items.push({ data: { providerId, recordingIds: list.slice(start, start + RESOLVE_BATCH) } })
  }
  pending.clear()
  if (items.length === 0) return
  try {
    await enqueueMany('acquisition.resolve', items)
  } catch (error) {
    // Lists must not fail because of this; the recordings are asked for again later.
    for (const { data } of items) for (const id of data.recordingIds) asked.delete(`${data.providerId}:${id}`)
    if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition] Could not queue resolves', error)
  }
}

/**
 * Forgets which of a provider's recordings were asked about recently (in this process), so
 * lists queue them again at once: its answers no longer count (misses.ts).
 */
export function forgetAsked(providerId: string) {
  for (const key of asked.keys()) if (key.startsWith(`${providerId}:`)) asked.delete(key)
}

/** Forgets queued and remembered resolves. Called on shutdown and between tests. */
export function resetResolveQueue() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  pending.clear()
  asked.clear()
}

/** `attempt` counts the times the provider was too busy to answer, for the backoff. */
export type ResolveJob = { providerId: string; recordingIds: string[]; attempt?: number }

/**
 * `acquisition.resolve`: asks a `must_resolve` provider about recordings nobody has asked
 * it about, stores the answers and invalidates whatever shows the ones that lit up.
 */
export async function runResolveJob({ providerId, recordingIds, attempt = 0 }: ResolveJob) {
  const provider = (await activeProviders()).find((candidate) => candidate.id === providerId)
  if (!provider) return
  const owned = await db.execute<{ id: string }>(sql`
    select distinct recording_id as id from media_files where recording_id = any(${uuidArray(recordingIds)}) and missing_since is null`)
  const ownedIds = new Set(owned.map((row) => row.id))
  let answers: Map<string, ProviderOffer[]>
  try {
    answers = await resolveRecordings(provider, recordingIds.filter((id) => !ownedIds.has(id)))
  } catch (error) {
    // Unanswered recordings stay gray and are asked about again when a list next shows them.
    if (!(error instanceof ProviderCallError)) throw error
    if (error.busy) {
      // Rate limited: not a fault to show the admin, and the answer is wanted soon, not in ten minutes.
      if (attempt < timing.busyRetries) {
        await enqueue<ResolveJob>('acquisition.resolve', { providerId, recordingIds, attempt: attempt + 1 }, {
          startAfter: busyWaitSeconds(attempt, error.retryAfterSeconds, { firstSeconds: timing.busyWaitSeconds }),
        })
      }
      return
    }
    await noteProviderError(provider.id, error.message)
    return
  }
  const lit = [...answers].filter(([, offers]) => offers.length > 0).map(([id]) => id)
  if (lit.length > 0) await announceAvailability(lit)
}

/**
 * Asks a provider about recordings and stores each answer: usable offers in the positive
 * cache, nothing usable as a miss. Returns the usable offers by recording; recordings the
 * provider did not answer for are left out. Throws `ProviderCallError`.
 */
export async function resolveRecordings(provider: ProviderEndpoint & { id: string }, ids: readonly string[], albumId?: string | null): Promise<Map<string, ProviderOffer[]>> {
  const queries = await recordingQueries(ids, albumId ?? null)
  const entries = [...queries]
  const answers = new Map<string, ProviderOffer[]>()
  for (let start = 0; start < entries.length; start += RESOLVE_BATCH) {
    const chunk = entries.slice(start, start + RESOLVE_BATCH)
    const response = await resolveItems(provider, { items: chunk.map(([, recording], index) => ({ ref: String(index), kind: 'recording' as const, recording })) })
    const byRef = new Map(response.items.map((item) => [item.ref, item.offers]))
    for (const [index, [id]] of chunk.entries()) {
      const offers = byRef.get(String(index))
      if (offers) answers.set(id, usableOffers(offers))
    }
  }
  await storeAnswers(provider.id, answers)
  return answers
}

async function storeAnswers(providerId: string, answers: Map<string, ProviderOffer[]>) {
  const now = new Date()
  const positive = [...answers].filter(([, offers]) => offers.length > 0)
  const negative = [...answers].filter(([, offers]) => offers.length === 0).map(([id]) => id)
  await db.transaction(async (tx) => {
    if (positive.length > 0) {
      await tx.insert(acquisitionOffers).values(positive.map(([recordingId, offers]) => ({ providerId, recordingId, offers, resolvedAt: now })))
        .onConflictDoUpdate({ target: [acquisitionOffers.providerId, acquisitionOffers.recordingId], set: { offers: sql`excluded.offers`, resolvedAt: now } })
      await tx.delete(acquisitionMisses).where(and(
        eq(acquisitionMisses.providerId, providerId), eq(acquisitionMisses.entityType, 'recording'),
        inArray(acquisitionMisses.entityId, positive.map(([id]) => id)),
      ))
    }
    if (negative.length > 0) await recordMisses(tx, providerId, 'recording', negative, 'The provider has no free offer for it')
  })
}

/** Usable offers a provider returned for a recording within the last hour. */
export async function freshOffers(providerId: string, recordingId: string): Promise<ProviderOffer[] | null> {
  const [row] = await db.select().from(acquisitionOffers).where(and(
    eq(acquisitionOffers.providerId, providerId), eq(acquisitionOffers.recordingId, recordingId),
    gt(acquisitionOffers.resolvedAt, new Date(Date.now() - FRESH_OFFER_MS)),
  ))
  return row ? usableOffers(row.offers as ProviderOffer[]) : null
}

/** Deletes misses and offers too old to count. */
export async function expireCaches(now = Date.now()) {
  await expireMisses(now)
  await db.delete(acquisitionOffers).where(lt(acquisitionOffers.resolvedAt, new Date(now - OFFER_TTL_MS)))
}

/**
 * What the server knows about each recording, as a provider is asked about it. The album
 * is a release the recording is on, `albumId`'s when it is one of them, else the album
 * hint of a search stub.
 */
export async function recordingQueries(ids: readonly string[], albumId: string | null): Promise<Map<string, ProviderRecordingQuery>> {
  if (ids.length === 0) return new Map()
  const rows = await db.execute<{
    id: string; mbid: string | null; isrcs: string[]; title: string; artist: string; durationMs: number | null
    albumTitle: string | null; albumMbid: string | null; year: number | null; disc: number | null; position: number | null
  }>(sql`
    select r.id, r.mbid, r.isrcs, r.title, r.artist_credit as artist, r.duration_ms as "durationMs",
      a.title as "albumTitle", a.mbid as "albumMbid", a.year, t.disc, t.position
    from recordings r
    left join lateral (
      select rel.album_id, rt.disc, rt.position from release_tracks rt join releases rel on rel.id = rt.release_id
      where rt.recording_id = r.id
      order by (rel.album_id = ${albumId}::uuid) desc nulls last, rt.id limit 1
    ) t on true
    left join albums a on a.id = coalesce(t.album_id, r.album_hint_id)
    where r.id = any(${uuidArray(ids)})`)
  return new Map(rows.map((row) => [row.id, {
    mbid: row.mbid,
    isrcs: row.isrcs ?? [],
    title: row.title,
    artist: row.artist,
    durationMs: row.durationMs,
    album: row.albumTitle === null ? null : { title: row.albumTitle, mbid: row.albumMbid, year: row.year, disc: row.disc, position: row.position },
  }]))
}

/**
 * Tells every client how available the recordings are now, and the albums they are on, so
 * rows turn gray or playable where they are. Nothing is refetched: a delivery or a miss
 * changes no list's members (cache is in no library), and searches are never run again
 * for it, which used to send every open search to the providers once per track.
 */
export async function announceAvailability(ids: readonly string[]) {
  const recordingIds = [...new Set(ids)]
  if (recordingIds.length === 0) return
  const albums = await db.execute<{ id: string }>(sql`
    select distinct rel.album_id as id from release_tracks rt join releases rel on rel.id = rt.release_id where rt.recording_id = any(${uuidArray(recordingIds)})
    union
    select album_id from media_files where recording_id = any(${uuidArray(recordingIds)}) and album_id is not null and missing_since is null
    union
    select album_hint_id from recordings where id = any(${uuidArray(recordingIds)}) and album_hint_id is not null`)
  const [tracks, albumInfo] = await Promise.all([trackAvailability(recordingIds), albumAvailability(albums.map((album) => album.id))])
  await publishChanges('all', [{
    kind: 'availability',
    tracks: [...tracks].map(([id, availability]) => ({ id, availability })),
    albums: [...albumInfo].map(([id, info]) => ({ id, ...info })),
  }])
}
