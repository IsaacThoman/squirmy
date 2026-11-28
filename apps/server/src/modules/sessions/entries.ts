import { canFetch } from '@squirmy/client-core'
import type { QueueSeed } from '@squirmy/contracts'
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, mediaFiles, recordings, users } from '../../database/schema.js'
import { onDemandRecordings } from '../acquisition/coverage.js'
import { cleanVersions, explicitAllowed, recordingExplicit } from '../catalog/explicit.js'

/**
 * Queue entries the server can trust. Clients send track ids with durations and states;
 * the server keeps only the ids and looks up the rest.
 */

export type TrackAvailability = 'server' | 'on_demand' | 'none'

type TrackInfo = { id: string; durationMs: number; availability: TrackAvailability; explicit: boolean }

/** Merge chains longer than this are treated as broken. */
const MAX_MERGE_DEPTH = 8

/** Maps each id to the row it was finally merged into; ids with no row are left out. */
async function followMerges(table: typeof recordings | typeof albums, ids: readonly string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  let pending = new Map([...new Set(ids)].map(id => [id, [id]]))
  for (let depth = 0; depth < MAX_MERGE_DEPTH && pending.size; depth += 1) {
    const rows = await db.select({ id: table.id, mergedIntoId: table.mergedIntoId }).from(table).where(inArray(table.id, [...pending.keys()]))
    const next = new Map<string, string[]>()
    for (const row of rows) {
      const origins = pending.get(row.id)!
      if (row.mergedIntoId) next.set(row.mergedIntoId, [...(next.get(row.mergedIntoId) ?? []), ...origins])
      else for (const origin of origins) resolved.set(origin, row.id)
    }
    pending = next
  }
  return resolved
}

/**
 * Availability and duration of recordings, keyed by the requested id. `id` is the
 * recording the request resolves to after merges; unknown ids are left out.
 *
 * Kept private to sessions until `catalog/availability.ts` provides the shared rule;
 * this follows the same one: a present file makes a track `server`, otherwise an
 * acquisition provider can make it `on_demand`.
 */
export async function lookupTracks(ids: readonly string[]): Promise<Map<string, TrackInfo>> {
  if (!ids.length) return new Map()
  const resolved = await followMerges(recordings, ids)
  const targets = [...new Set(resolved.values())]
  if (!targets.length) return new Map()
  const [rows, files] = await Promise.all([
    db.select({ id: recordings.id, durationMs: recordings.durationMs, explicit: recordingExplicit(sql`${recordings.id}`, sql`${recordings.explicit}`).mapWith(Boolean) })
      .from(recordings).where(inArray(recordings.id, targets)),
    db.select({ recordingId: mediaFiles.recordingId, durationMs: max(mediaFiles.durationMs) }).from(mediaFiles)
      .where(and(inArray(mediaFiles.recordingId, targets), isNull(mediaFiles.missingSince)))
      .groupBy(mediaFiles.recordingId),
  ])
  const owned = new Map(files.map(file => [file.recordingId!, file.durationMs ?? 0]))
  const onDemand = await onDemandRecordings(targets.filter(id => !owned.has(id)))
  const info = new Map(rows.map(row => [row.id, {
    id: row.id,
    durationMs: row.durationMs ?? owned.get(row.id) ?? 0,
    availability: owned.has(row.id) ? 'server' as const : onDemand.has(row.id) ? 'on_demand' as const : 'none' as const,
    explicit: row.explicit,
  }]))
  const result = new Map<string, TrackInfo>()
  for (const [requested, target] of resolved) {
    const track = info.get(target)
    if (track) result.set(requested, track)
  }
  return result
}

/**
 * Whether tracks may be fetched for the user: an admin or a member with `canAcquire`
 * whose account is enabled, the same rule acquisition applies to a request.
 */
export async function isRequester(userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return Boolean(user && !user.disabledAt && canFetch(user))
}

/**
 * Rebuilds client-sent seeds from the database for `userId`: canonical recording and
 * album ids, the recording's duration, and `ready` or `preparing` by availability. Tracks
 * the user cannot play are dropped: `none` for everyone, and `on_demand` for a user who
 * may not have tracks fetched, whose entry would otherwise sit preparing and then fail.
 * For a user who does not allow explicit content, an explicit track gives way to a known
 * clean version that plays for them (`cleanVersions`), with no album context, and is
 * dropped when there is none.
 * `indexes[i]` is the position in `seeds` of the i-th kept seed.
 */
export async function trustSeeds(userId: string, seeds: readonly QueueSeed[]): Promise<{ seeds: QueueSeed[]; indexes: number[] }> {
  const albumIds = seeds.flatMap(seed => (seed.albumId ? [seed.albumId] : []))
  const [tracks, albumMap, allowsExplicit] = await Promise.all([
    lookupTracks(seeds.map(seed => seed.trackId)),
    albumIds.length ? followMerges(albums, albumIds) : new Map<string, string>(),
    explicitAllowed(userId),
  ])
  const blocked = (track: TrackInfo) => track.explicit && !allowsExplicit
  const clean = await cleanTracks([...tracks.values()].filter(blocked).map(track => track.id))
  // Asked only when it matters, so a queue of owned tracks costs no extra query.
  const fetchable = [...tracks.values(), ...[...clean.values()].flat()].some(track => track.availability === 'on_demand') && await isRequester(userId)
  const plays = (track: TrackInfo) => !blocked(track) && (track.availability === 'server' || (track.availability === 'on_demand' && fetchable))
  const trusted: QueueSeed[] = []
  const indexes: number[] = []
  for (const [index, seed] of seeds.entries()) {
    const original = tracks.get(seed.trackId)
    const track = original && blocked(original) ? clean.get(original.id)?.find(plays) : original
    if (!track || !plays(track)) continue
    trusted.push({
      trackId: track.id,
      // A clean version is on another release, so the explicit one's album is not its.
      albumId: track === original && seed.albumId ? albumMap.get(seed.albumId) ?? null : null,
      durationMs: track.durationMs,
      state: track.availability === 'server' ? 'ready' : 'preparing',
    })
    indexes.push(index)
  }
  return { seeds: trusted, indexes }
}

/** The known clean versions of explicit recordings, best first, with their availability. */
async function cleanTracks(explicitIds: readonly string[]): Promise<Map<string, TrackInfo[]>> {
  if (!explicitIds.length) return new Map()
  const versions = await cleanVersions(explicitIds)
  const info = await lookupTracks([...new Set([...versions.values()].flat())])
  return new Map([...versions].map(([id, cleanIds]) => [id, cleanIds.flatMap(cleanId => info.get(cleanId) ?? [])]))
}

type HeldEntry = { trackId: string; albumId: string | null; durationMs: number }

/**
 * What the catalog says now of tracks entries were made from: the row each was merged
 * into, if any, and its length; the same for albums. Only what differs from the entries
 * is returned, ready for `updateTracks`. A length the catalog does not know is not taken.
 */
export async function entryUpdates(entries: readonly HeldEntry[]): Promise<{
  tracks: { trackId: string; id: string; durationMs: number }[]
  albums: { albumId: string; id: string }[]
}> {
  const trackIds = [...new Set(entries.map(entry => entry.trackId))]
  const albumIds = [...new Set(entries.flatMap(entry => (entry.albumId ? [entry.albumId] : [])))]
  const [tracks, albumMap] = await Promise.all([lookupTracks(trackIds), albumIds.length ? followMerges(albums, albumIds) : new Map<string, string>()])
  const lengths = new Map<string, Set<number>>()
  for (const entry of entries) lengths.set(entry.trackId, (lengths.get(entry.trackId) ?? new Set()).add(entry.durationMs))
  const changedTracks = trackIds.flatMap(trackId => {
    const track = tracks.get(trackId)
    if (!track) return []
    const durationMs = track.durationMs || [...lengths.get(trackId)!][0]!
    const same = track.id === trackId && [...lengths.get(trackId)!].every(length => length === durationMs)
    return same ? [] : [{ trackId, id: track.id, durationMs }]
  })
  const changedAlbums = albumIds.flatMap(albumId => {
    const id = albumMap.get(albumId)
    return id && id !== albumId ? [{ albumId, id }] : []
  })
  return { tracks: changedTracks, albums: changedAlbums }
}
