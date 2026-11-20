import type { QueueSeed } from '@squirmy/contracts'
import { and, inArray, isNull, max } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, mediaFiles, recordings } from '../../database/schema.js'
import { onDemandRecordings } from '../acquisition/coverage.js'

/**
 * Queue entries the server can trust. Clients send track ids with durations and states;
 * the server keeps only the ids and looks up the rest.
 */

export type TrackAvailability = 'server' | 'on_demand' | 'none'

type TrackInfo = { id: string; durationMs: number; availability: TrackAvailability }

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
    db.select({ id: recordings.id, durationMs: recordings.durationMs }).from(recordings).where(inArray(recordings.id, targets)),
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
  }]))
  const result = new Map<string, TrackInfo>()
  for (const [requested, target] of resolved) {
    const track = info.get(target)
    if (track) result.set(requested, track)
  }
  return result
}

/**
 * Rebuilds client-sent seeds from the database: canonical recording and album ids, the
 * recording's duration, and `ready` or `preparing` by availability. Tracks that cannot be
 * played are dropped. `indexes[i]` is the position in `seeds` of the i-th kept seed.
 */
export async function trustSeeds(seeds: readonly QueueSeed[]): Promise<{ seeds: QueueSeed[]; indexes: number[] }> {
  const albumIds = seeds.flatMap(seed => (seed.albumId ? [seed.albumId] : []))
  const [tracks, albumMap] = await Promise.all([
    lookupTracks(seeds.map(seed => seed.trackId)),
    albumIds.length ? followMerges(albums, albumIds) : new Map<string, string>(),
  ])
  const trusted: QueueSeed[] = []
  const indexes: number[] = []
  for (const [index, seed] of seeds.entries()) {
    const track = tracks.get(seed.trackId)
    if (!track || track.availability === 'none') continue
    trusted.push({
      trackId: track.id,
      albumId: seed.albumId ? albumMap.get(seed.albumId) ?? null : null,
      durationMs: track.durationMs,
      state: track.availability === 'server' ? 'ready' : 'preparing',
    })
    indexes.push(index)
  }
  return { seeds: trusted, indexes }
}
