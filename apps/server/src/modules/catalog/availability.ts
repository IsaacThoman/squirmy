/**
 * The one place that decides availability (docs/architecture.md, "Availability").
 *
 * - A recording is owned when a present media file (`missing_since` is null) links to it.
 * - An unowned recording is `on_demand` when the acquisition seam says a provider can
 *   supply it, else `none`.
 * - An album counts owned recordings on its track list (`albumTrackList` in pages.ts): its
 *   canonical release, plus owned recordings of files of that edition that the release
 *   does not list (a file of another edition the server holds counts on that edition). All is `full`, some is `partial`. With none owned it is `on_demand` when
 *   any track is (decision 6: dimmed only when nothing on it plays; one track a provider
 *   missed must not gray out an EP whose other songs play), else `none`. An album with a present, linked file is therefore never
 *   `none`, which is what keeps a library album from showing gray. An album with no track
 *   list yet (a search result) is `on_demand` while an `assume_available` provider is
 *   active (`albumCoveredWithoutTracks`), else `none`.
 *
 * Library membership is separate from availability and lives here too (`inLibraryAlbum`,
 * `inLibraryRecording`): a user's library is what that user saved with the heart (`likes`),
 * plus the server's collection (present files no provider delivered) for a user who turned
 * on `libraryIncludesServerMusic` (`collectionCounts`). Without a user the same helpers
 * answer for the collection alone: the server's music, which `/collection/*` lists. A file
 * fetched for playing is cache, so it makes a track `server` without putting anything in a
 * library.
 */
import { INCOMING_FOLDER, type AlbumAvailability, type TrackAvailability } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albumCoveredWithoutTracks, onDemandRecordings } from '../acquisition/coverage.js'
import { uuidArray } from './sql.js'

/** SQL condition: a present file links to the recording id expression. */
export function recordingOwned(recordingId: string): SQL {
  return sql.raw(`exists (select 1 from media_files owned_file where owned_file.recording_id = ${recordingId} and owned_file.missing_since is null)`)
}

/** SQL condition: the file (alias) is part of the collection: present and not delivered by a provider. */
export function collectionFile(alias: string): SQL {
  return sql.raw(`(${alias}.missing_since is null and not ${alias}.cached)`)
}

/**
 * SQL condition: the server's collection counts toward the user's library, because they
 * turned on `libraryIncludesServerMusic` (off by default). Without a user it always does:
 * that is the server's music. Every collection branch of a membership query is gated by
 * this one condition. It does not depend on the row, so Postgres runs it once per
 * statement (an InitPlan) and skips the branches it gates when it is false.
 */
export function collectionCounts(userId: string | null): SQL {
  if (!userId) return sql`true`
  return sql`exists (select 1 from users opted where opted.id = ${userId} and opted.settings @> '{"libraryIncludesServerMusic": true}'::jsonb)`
}

/**
 * Whether a collection file is linked to any of the albums, so their changes move every
 * user's library. Files still in an import's incoming folder do not count: until the import
 * marks them, a provider's delivery looks like the collection, and a finished import
 * announces the library's lists itself.
 */
export async function holdsCollection(albumIds: readonly string[]): Promise<boolean> {
  if (albumIds.length === 0) return false
  const [row] = await db.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from media_files f
      where f.album_id = any(${uuidArray([...new Set(albumIds)])}) and ${collectionFile('f')} and not starts_with(f.rel_path, ${`${INCOMING_FOLDER}/`})
    ) as held`)
  return Boolean(row?.held)
}

/**
 * The users who saved (hearted) any of the albums or recordings. A cached file arriving at or leaving
 * one of these changes their library's songs (songs of a saved album show as their files
 * arrive, and a saved song takes its place in the year order from its file), and nobody
 * else's library.
 */
export async function saversOf(albumIds: readonly string[], recordingIds: readonly string[]): Promise<string[]> {
  if (albumIds.length + recordingIds.length === 0) return []
  const rows = await db.execute<{ userId: string }>(sql`
    select distinct user_id as "userId" from likes
    where (entity_type = 'album' and entity_id = any(${uuidArray([...new Set(albumIds)])}))
      or (entity_type = 'recording' and entity_id = any(${uuidArray([...new Set(recordingIds)])}))`)
  return rows.map((row) => row.userId)
}

export type Membership = {
  /** Album pages' `library`: `collection` wins over a save. */
  albums: Map<string, 'collection' | 'saved' | null>
  /** `TrackSummary.library` (in the library when not null). */
  recordings: Map<string, 'collection' | 'album' | 'saved' | null>
  /** `ArtistSummary.inLibrary`: saved, or credited on an album in the library. */
  artists: Map<string, boolean>
}

/**
 * The user's membership of these entities as their summaries and pages say it, for telling
 * the user's devices what a save changed without them fetching the pages again.
 */
export async function membership(userId: string, ids: { albums?: readonly string[]; recordings?: readonly string[]; artists?: readonly string[] }): Promise<Membership> {
  const albums = [...new Set(ids.albums ?? [])]
  const recordings = [...new Set(ids.recordings ?? [])]
  const artists = [...new Set(ids.artists ?? [])]
  const [albumRows, recordingRows, artistRows] = await Promise.all([
    albums.length === 0 ? [] : db.execute<{ id: string; library: 'collection' | 'saved' | null }>(sql`
      select a.id, case
        when ${collectionCounts(userId)} and exists (select 1 from media_files f where f.album_id = a.id and ${collectionFile('f')}) then 'collection'
        when ${saved('album', 'a.id', userId)} then 'saved'
      end as library
      from albums a where a.id = any(${uuidArray(albums)})`),
    recordings.length === 0 ? [] : db.execute<{ id: string; library: 'collection' | 'album' | 'saved' | null }>(sql`
      select r.id, ${recordingLibrary('r.id', userId)} as library from recordings r where r.id = any(${uuidArray(recordings)})`),
    artists.length === 0 ? [] : db.execute<{ id: string; inLibrary: boolean }>(sql`
      select ar.id, (${saved('artist', 'ar.id', userId)}
        or exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${inLibraryAlbum('aa.album_id', userId)})) as "inLibrary"
      from artists ar where ar.id = any(${uuidArray(artists)})`),
  ])
  return {
    albums: new Map(albumRows.map((row) => [row.id, row.library])),
    recordings: new Map(recordingRows.map((row) => [row.id, row.library])),
    artists: new Map(artistRows.map((row) => [row.id, row.inLibrary])),
  }
}

/** SQL condition: the user saved (hearted) the entity (expression). */
export function saved(type: 'album' | 'recording' | 'artist', entity: string, userId: string): SQL {
  return sql`exists (select 1 from likes saved where saved.user_id = ${userId} and saved.entity_type = ${type} and saved.entity_id = ${sql.raw(entity)})`
}

/**
 * SQL condition: the album id expression is in the user's library, because the user saved
 * it, or a collection file is linked to it and the collection counts for them
 * (`collectionCounts`). Without a user, collection only.
 */
export function inLibraryAlbum(album: string, userId: string | null): SQL {
  const owned = sql`(${collectionCounts(userId)} and exists (select 1 from media_files collected where collected.album_id = ${sql.raw(album)} and ${collectionFile('collected')}))`
  return userId ? sql`(${owned} or ${saved('album', album, userId)})` : owned
}

/**
 * SQL condition: the recording id expression is in the user's library: the user saved it,
 * a present file of it (cache included) belongs to an album the user saved, or a
 * collection file links it and the collection counts for them. Without a user, collection only.
 */
export function inLibraryRecording(recording: string, userId: string | null): SQL {
  const owned = collectedRecording(recording, userId)
  if (!userId) return owned
  return sql`(${owned} or ${saved('recording', recording, userId)} or ${savedAlbumHolds(recording, userId)})`
}

/**
 * SQL expression: why the recording id expression is in the user's library, the first of
 * `collection` (a collection file links it and the collection counts for the user), `album` (a present file of it is on an album the
 * user saved) and `saved` (the user saved the recording), or null when it is not. Only `saved`
 * is something removing the track takes away: in the other two it stays.
 */
export function recordingLibrary(recording: string, userId: string | null): SQL {
  if (!userId) return sql`case when ${collectedRecording(recording, null)} then 'collection' end`
  return sql`case
    when ${collectedRecording(recording, userId)} then 'collection'
    when ${savedAlbumHolds(recording, userId)} then 'album'
    when ${saved('recording', recording, userId)} then 'saved'
  end`
}

/** SQL condition: a collection file links the recording, and the collection counts for the user. */
function collectedRecording(recording: string, userId: string | null): SQL {
  return sql`(${collectionCounts(userId)} and exists (select 1 from media_files collected where collected.recording_id = ${sql.raw(recording)} and ${collectionFile('collected')}))`
}

function savedAlbumHolds(recording: string, userId: string): SQL {
  return sql`exists (
    select 1 from media_files present join likes album_saved
      on album_saved.user_id = ${userId} and album_saved.entity_type = 'album' and album_saved.entity_id = present.album_id
    where present.recording_id = ${sql.raw(recording)} and present.missing_since is null)`
}

/**
 * SQL expression for the release whose track list stands for the album (alias given):
 * its canonical release, or for an album without one, its release with the most tracks.
 */
export function canonicalRelease(album: string): SQL {
  return sql.raw(canonicalReleaseText(album))
}

/** `canonicalRelease` as text, for other raw fragments. */
export function canonicalReleaseText(album: string): string {
  return `coalesce(${album}.canonical_release_id, (select fallback.id from releases fallback where fallback.album_id = ${album}.id order by fallback.track_count desc, fallback.id limit 1))`
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
  /** Tracks on the album's track list: the canonical release, then owned extras of that edition. */
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
        -- A file of another edition the server holds counts on that edition, not here.
        and not exists (
          select 1 from releases other
          where other.id = f.release_id and other.mbid is not null and other.album_id = a.id and other.id <> ${canonicalRelease('a')}
        )
    ) extras
    where a.id = any(${uuidArray(ids)})
    group by a.id, extras.count`)

  const candidates = rows.filter((row) => row.ownedTrackCount === 0 && row.trackCount > 0).flatMap((row) => row.unowned)
  const onDemand = candidates.length > 0 ? await onDemandRecordings([...new Set(candidates)]) : new Set<string>()
  // An album search found has no track list until its detail is fetched; a provider that
  // fetches anything can still play it (the acquisition seam decides).
  const emptyCovered = rows.some((row) => row.trackCount === 0) && await albumCoveredWithoutTracks()
  return new Map(rows.map((row) => {
    let availability: AlbumAvailability
    if (row.trackCount > 0 && row.ownedTrackCount === row.trackCount) availability = 'full'
    else if (row.ownedTrackCount > 0) availability = 'partial'
    else if (row.trackCount > 0 && row.unowned.some((id) => onDemand.has(id))) availability = 'on_demand'
    else if (row.trackCount === 0 && emptyCovered) availability = 'on_demand'
    else availability = 'none'
    return [row.id, { availability, trackCount: row.trackCount, ownedTrackCount: row.ownedTrackCount }]
  }))
}
