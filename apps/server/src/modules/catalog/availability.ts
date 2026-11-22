/**
 * The one place that decides availability (docs/architecture.md, "Availability").
 *
 * - A recording is owned when a present media file (`missing_since` is null) links to it.
 * - An unowned recording is `on_demand` when the acquisition seam says a provider can
 *   supply it, else `none`.
 * - An album counts owned recordings on its track list (`albumTrackList` in pages.ts): its
 *   canonical release, plus owned recordings filed under the album that the release does
 *   not list. All is `full`, some is `partial`. With none owned it is `on_demand` when
 *   every track is, else `none`. An album with a present, linked file is therefore never
 *   `none`, which is what keeps a library album from showing gray.
 *
 * Library membership is separate from availability and lives here too (`inLibraryAlbum`,
 * `inLibraryRecording`): a user's library is the server's collection (present files no
 * provider delivered) plus what that user saved in `library_items`. A file fetched for
 * playing is cache, so it makes a track `server` without putting anything in a library.
 */
import type { AlbumAvailability, TrackAvailability } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { onDemandRecordings } from '../acquisition/coverage.js'
import { uuidArray } from './sql.js'

/** SQL condition: a present file links to the recording id expression. */
export function recordingOwned(recordingId: string): SQL {
  return sql.raw(`exists (select 1 from media_files owned_file where owned_file.recording_id = ${recordingId} and owned_file.missing_since is null)`)
}

/** SQL condition: the file (alias) is part of the collection: present and not delivered by a provider. */
export function collectionFile(alias: string): SQL {
  return sql.raw(`(${alias}.missing_since is null and not ${alias}.cached)`)
}

/** SQL condition: the user saved the entity (expression) to their library. */
function saved(type: 'album' | 'recording', entity: string, userId: string): SQL {
  return sql`exists (select 1 from library_items saved where saved.user_id = ${userId} and saved.entity_type = ${type} and saved.entity_id = ${sql.raw(entity)})`
}

/**
 * SQL condition: the album id expression is in the user's library, because a collection
 * file is linked to it or the user saved it. Without a user, collection only.
 */
export function inLibraryAlbum(album: string, userId: string | null): SQL {
  const owned = sql`exists (select 1 from media_files collected where collected.album_id = ${sql.raw(album)} and ${collectionFile('collected')})`
  return userId ? sql`(${owned} or ${saved('album', album, userId)})` : owned
}

/**
 * SQL condition: the recording id expression is in the user's library: a collection file
 * links it, the user saved it, or a present file of it belongs to an album the user saved.
 * Without a user, collection only.
 */
export function inLibraryRecording(recording: string, userId: string | null): SQL {
  const owned = sql`exists (select 1 from media_files collected where collected.recording_id = ${sql.raw(recording)} and ${collectionFile('collected')})`
  if (!userId) return owned
  const viaAlbum = sql`exists (
    select 1 from media_files present join library_items album_saved
      on album_saved.user_id = ${userId} and album_saved.entity_type = 'album' and album_saved.entity_id = present.album_id
    where present.recording_id = ${sql.raw(recording)} and present.missing_since is null)`
  return sql`(${owned} or ${saved('recording', recording, userId)} or ${viaAlbum})`
}

/**
 * SQL expression for the release whose track list stands for the album (alias given):
 * its canonical release, or for an album without one, its release with the most tracks.
 */
export function canonicalRelease(album: string): SQL {
  return sql.raw(`coalesce(${album}.canonical_release_id, (select fallback.id from releases fallback where fallback.album_id = ${album}.id order by fallback.track_count desc, fallback.id limit 1))`)
}

/** Availability of each existing recording id. Ids must already be redirect-resolved. */
export async function trackAvailability(recordingIds: readonly string[]): Promise<Map<string, TrackAvailability>> {
  const ids = [...new Set(recordingIds)]
  if (ids.length === 0) return new Map()
  const owned = await db.execute<{ id: string }>(sql`
    select distinct recording_id as id from media_files
    where recording_id = any(${uuidArray(ids)}) and missing_since is null`)
  const ownedIds = new Set(owned.map((row) => row.id))
  const unowned = ids.filter((id) => !ownedIds.has(id))
  const onDemand = unowned.length > 0 ? await onDemandRecordings(unowned) : new Set<string>()
  return new Map(ids.map((id) => [id, ownedIds.has(id) ? 'server' : onDemand.has(id) ? 'on_demand' : 'none']))
}

export type AlbumAvailabilityInfo = {
  availability: AlbumAvailability
  /** Tracks on the album's track list: the canonical release, then owned extras. */
  trackCount: number
  /** Of those, the ones whose recording is owned. */
  ownedTrackCount: number
}

/** Availability and track counts of each existing album id. Ids must already be redirect-resolved. */
export async function albumAvailability(albumIds: readonly string[]): Promise<Map<string, AlbumAvailabilityInfo>> {
  const ids = [...new Set(albumIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.execute<{ id: string; trackCount: number; ownedTrackCount: number; unowned: string[] }>(sql`
    select a.id,
      (count(t.id) + extras.count)::int as "trackCount",
      (count(t.id) filter (where t.owned) + extras.count)::int as "ownedTrackCount",
      coalesce(array_agg(t.recording_id) filter (where not t.owned), '{}') as unowned
    from albums a
    left join lateral (
      select rt.id, rt.recording_id, ${recordingOwned('rt.recording_id')} as owned
      from release_tracks rt where rt.release_id = ${canonicalRelease('a')}
    ) t on true
    cross join lateral (
      select count(distinct f.recording_id) as count from media_files f
      where f.album_id = a.id and f.recording_id is not null and f.missing_since is null
        and not exists (
          select 1 from release_tracks listed
          where listed.release_id = ${canonicalRelease('a')} and listed.recording_id = f.recording_id
        )
    ) extras
    where a.id = any(${uuidArray(ids)})
    group by a.id, extras.count`)

  const candidates = rows.filter((row) => row.ownedTrackCount === 0 && row.trackCount > 0).flatMap((row) => row.unowned)
  const onDemand = candidates.length > 0 ? await onDemandRecordings([...new Set(candidates)]) : new Set<string>()
  return new Map(rows.map((row) => {
    let availability: AlbumAvailability
    if (row.trackCount > 0 && row.ownedTrackCount === row.trackCount) availability = 'full'
    else if (row.ownedTrackCount > 0) availability = 'partial'
    else if (row.trackCount > 0 && row.unowned.every((id) => onDemand.has(id))) availability = 'on_demand'
    else availability = 'none'
    return [row.id, { availability, trackCount: row.trackCount, ownedTrackCount: row.ownedTrackCount }]
  }))
}
