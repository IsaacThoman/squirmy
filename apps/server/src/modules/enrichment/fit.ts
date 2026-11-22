/**
 * Folds rows that only stood in for an album's tracks into the recordings of its canonical
 * release, so a song is listed (and owned, and played) once.
 *
 * Stand-ins have no MBID: a search or Deezer top-track stub, a row built from Deezer, or
 * the local recording of a file that was filed under the album before its MusicBrainz
 * release was known. Deezer's top tracks carry no ISRC, so title and length have to do
 * when there is none.
 */
import { sql } from 'drizzle-orm'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { canonicalRelease } from '../catalog/availability.js'
import { uuidArray } from '../catalog/sql.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeRecording } from '../matching/merge.js'
import { editionFreeKey, textArray } from '../search/keys.js'

/** Two recordings of one song differ in length by at most this. */
const lengthToleranceMs = 5000

type Row = { id: string; title: string; durationMs: number | null; isrcs: string[] }
type Stray = Row & { filed: boolean }

/**
 * Merges each stand-in into the one canonical track it is. Stand-ins are recordings
 * without an MBID that are not on the release, found three ways, each an indexed lookup:
 *
 * - filed: the recording of a present file whose `album_id` is this album. Matching and
 *   acquisition own how files are linked, so this is kept narrow: only a title and length
 *   fit (the only track with the same edition-free title, both lengths known, within five
 *   seconds), never an ISRC alone.
 * - by ISRC: a recording with no file that shares an ISRC with exactly one track.
 * - loose: a recording with no file and on no release (a search or top-track stub) led by
 *   an artist of the album, fitted by title and length as above.
 *
 * Returns how many were merged. Call it under `lockUpserts`.
 */
export async function fitStrayRecordings(tx: Transaction, albumId: string): Promise<number> {
  const tracks = await tx.execute<Row & { artistId: string | null }>(sql`
    select distinct r.id, r.title, r.duration_ms as "durationMs", r.isrcs, r.primary_artist_id as "artistId"
    from albums a join release_tracks rt on rt.release_id = ${canonicalRelease('a')} join recordings r on r.id = rt.recording_id
    where a.id = ${albumId} and r.merged_into_id is null`)
  if (tracks.length === 0) return 0
  const trackIds = uuidArray(tracks.map((track) => track.id))
  const credited = await tx.execute<{ id: string }>(sql`select artist_id as id from album_artists where album_id = ${albumId}`)
  const artistIds = [...new Set([...tracks.flatMap((track) => (track.artistId ? [track.artistId] : [])), ...credited.map((row) => row.id)])]
  const isrcs = [...new Set(tracks.flatMap((track) => track.isrcs))]
  const stub = sql`s.mbid is null and s.merged_into_id is null and not (s.id = any(${trackIds}))`
  const noFiles = sql`not exists (select 1 from media_files f where f.recording_id = s.id)`

  const strays = await tx.execute<Stray>(sql`
    select distinct on (id) id, title, "durationMs", isrcs, filed from (
      select s.id, s.title, s.duration_ms as "durationMs", s.isrcs, true as filed
      from media_files f join recordings s on s.id = f.recording_id
      where f.album_id = ${albumId} and f.missing_since is null and ${stub}
      ${isrcs.length === 0 ? sql`` : sql`union all
      select s.id, s.title, s.duration_ms, s.isrcs, false
      from recordings s where s.isrcs && ${textArray(isrcs)} and ${stub} and ${noFiles}`}
      ${artistIds.length === 0 ? sql`` : sql`union all
      select s.id, s.title, s.duration_ms, s.isrcs, false
      from recordings s where s.primary_artist_id = any(${uuidArray(artistIds)}) and ${stub} and ${noFiles}
        and not exists (select 1 from release_tracks rt where rt.recording_id = s.id)`}
    ) candidates
    order by id, filed desc`)

  let merged = 0
  for (const stray of strays) {
    const into = fit(stray, tracks)
    if (!into) continue
    await mergeRecording(stray.id, into, tx)
    merged += 1
  }
  return merged
}

/** The one track `stray` is, or null when none or several qualify. */
function fit(stray: Stray, tracks: readonly Row[]): string | null {
  if (!stray.filed) {
    const byIsrc = new Set(tracks.filter((track) => track.isrcs.some((isrc) => stray.isrcs.includes(isrc))).map((track) => track.id))
    if (byIsrc.size > 0) return byIsrc.size === 1 ? [...byIsrc][0]! : null
  }
  const key = editionFreeKey(stray.title)
  if (!key) return null
  const sameTitle = tracks.filter((track) => editionFreeKey(track.title) === key)
  if (sameTitle.length !== 1) return null
  const track = sameTitle[0]!
  // Both carry ISRCs and share none: two recordings (a live take, a re-recording) of one title.
  if (stray.isrcs.length > 0 && track.isrcs.length > 0 && !stray.isrcs.some((isrc) => track.isrcs.includes(isrc))) return null
  if (stray.durationMs === null || track.durationMs === null) return null
  return Math.abs(stray.durationMs - track.durationMs) <= lengthToleranceMs ? track.id : null
}

/**
 * Whether the album has a present file on an MBID-less recording its canonical release
 * does not list: the only stand-in that can turn up without the release being written
 * again (a fetched track filed under a complete album). One indexed lookup, no lock.
 */
export async function hasStrayFiles(albumId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from albums a
      join media_files f on f.album_id = a.id and f.missing_since is null
      join recordings r on r.id = f.recording_id and r.mbid is null and r.merged_into_id is null
      where a.id = ${albumId}
        and not exists (select 1 from release_tracks rt where rt.release_id = ${canonicalRelease('a')} and rt.recording_id = r.id)
    ) as found`)
  return Boolean(row?.found)
}

/** `fitStrayRecordings` in its own transaction, only when `hasStrayFiles` says there is something to fit. */
export async function fitStrayFilesNow(albumId: string): Promise<number> {
  if (!(await hasStrayFiles(albumId))) return 0
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    return fitStrayRecordings(tx, albumId)
  })
}
