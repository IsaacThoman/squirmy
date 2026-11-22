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
import { db, type Transaction } from '../../database/client.js'
import { canonicalRelease } from '../catalog/availability.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeRecording } from '../matching/merge.js'
import { uuidArray } from '../catalog/sql.js'
import { editionFreeKey, textArray } from '../search/keys.js'

/** Two recordings of one song differ in length by at most this. */
const lengthToleranceMs = 5000

type Row = { id: string; title: string; durationMs: number | null; isrcs: string[] }
type Stray = Row & { filed: boolean }

/**
 * Merges each stand-in into the one canonical track it is: the track sharing an ISRC, else
 * the only track with the same title once edition suffixes are dropped whose length is
 * within five seconds. Stand-ins are recordings without an MBID that are not on the
 * release and either have a present file filed under the album, or have no file and share
 * an ISRC with a track, or have no file, are on no release and are led by an artist of the
 * album (loose stubs). A loose stub needs both lengths. Returns how many were merged. Call
 * it under `lockUpserts`.
 */
export async function fitStrayRecordings(tx: Transaction, albumId: string): Promise<number> {
  const tracks = await tx.execute<Row & { artistId: string | null }>(sql`
    select distinct r.id, r.title, r.duration_ms as "durationMs", r.isrcs, r.primary_artist_id as "artistId"
    from albums a join release_tracks rt on rt.release_id = ${canonicalRelease('a')} join recordings r on r.id = rt.recording_id
    where a.id = ${albumId} and r.merged_into_id is null`)
  if (tracks.length === 0) return 0
  const trackIds = tracks.map((track) => track.id)
  const artistIds = [...new Set(tracks.flatMap((track) => (track.artistId ? [track.artistId] : [])))]
  const isrcs = [...new Set(tracks.flatMap((track) => track.isrcs))]

  const strays = await tx.execute<Stray>(sql`
    select s.id, s.title, s.duration_ms as "durationMs", s.isrcs,
      exists (select 1 from media_files f where f.recording_id = s.id and f.album_id = ${albumId} and f.missing_since is null) as filed
    from recordings s
    where s.mbid is null and s.merged_into_id is null and not (s.id = any(${uuidArray(trackIds)}))
      and (
        exists (select 1 from media_files f where f.recording_id = s.id and f.album_id = ${albumId} and f.missing_since is null)
        or (not exists (select 1 from media_files f where f.recording_id = s.id) and (
          s.isrcs && ${textArray(isrcs)}
          or ((s.primary_artist_id = any(${uuidArray(artistIds)})
              or s.primary_artist_id in (select aa.artist_id from album_artists aa where aa.album_id = ${albumId}))
            and not exists (select 1 from release_tracks rt where rt.recording_id = s.id))
        ))
      )`)

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
  const byIsrc = new Set(tracks.filter((track) => track.isrcs.some((isrc) => stray.isrcs.includes(isrc))).map((track) => track.id))
  if (byIsrc.size > 0) return byIsrc.size === 1 ? [...byIsrc][0]! : null
  const key = editionFreeKey(stray.title)
  if (!key) return null
  const sameTitle = tracks.filter((track) => editionFreeKey(track.title) === key)
  if (sameTitle.length !== 1) return null
  const [track] = sameTitle
  const lengths = stray.durationMs !== null && track!.durationMs !== null
  if (!lengths) return stray.filed ? track!.id : null
  return Math.abs(stray.durationMs! - track!.durationMs!) <= lengthToleranceMs ? track!.id : null
}

/** `fitStrayRecordings` in its own transaction. */
export async function fitStrayRecordingsNow(albumId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    return fitStrayRecordings(tx, albumId)
  })
}
