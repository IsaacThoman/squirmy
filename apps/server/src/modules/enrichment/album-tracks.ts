/**
 * The album-track repair: albums that list a song twice. The canonical release lists it
 * once, and the album lists it again below that, as a row from another of its track lists
 * (Deezer's, or one built from a delivery's tags) or from a file filed under it, because
 * older code did not see that the two rows were the same song. Typical causes are another
 * ISRC for one master, "I'm The Man" against "I’m the Man", or a release of another mix
 * chosen as canonical. On the test instance ADÉLA's PRIMA listed five songs twice, and
 * four other albums one song each. The twin without a file was gray while the other played.
 *
 * Albums with such a stand-in (no MBID, not on the canonical release, with a canonical
 * track's title, an ISRC of one, or its place and length) are fitted again (`fit.ts`, which
 * merges by `track-identity.ts`) under the upsert lock. Merges leave redirects and move
 * files, likes, plays, playlist items and wants, so ids that queues and playlists hold
 * keep working. With Deezer on, an album where that merged something reads its Deezer
 * track list again (`linkDeezerAlbum`), so its tracks learn the store's codes.
 *
 * Second, a track with no file whose song the server holds on another release (a recording
 * of the album's artist with the same title and a present file) plays that copy. With a
 * shared ISRC the two are one song (`joinHeldCopies` in `fit.ts`); without one, the album's
 * Deezer track list is read again first, so the track learns the store's code for the song
 * on this album. PRIMA's "Red Bottoms" is the Dolby Atmos recording on the album and the
 * stereo recording of the single the server has; selecting albums for the Deezer read by
 * "merged this run" missed it once its twins had been folded in. Bounded per run; running it
 * again changes nothing.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { canonicalRelease } from '../catalog/availability.js'
import { lockUpserts } from '../matching/apply.js'
import { deezer } from '../metadata/index.js'
import { deezerAlbumOf } from './album.js'
import { linkDeezerAlbum } from './deezer-rows.js'
import { fitStrayRecordings } from './fit.js'
import { attempt, changed } from './rows.js'

/** Albums fitted again per run. */
const albumBatch = 500
/** Albums whose Deezer track list is read again per run: one or two Deezer requests each. */
const deezerBatch = 100

export type AlbumTrackRepair = { albums: number; merged: number; relinked: number }

/** The albums that may list a song twice, as the module comment describes. */
export async function albumsWithTwins(limit = albumBatch): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.merged_into_id is null and exists (
      select 1 from release_tracks ct join recordings c on c.id = ct.recording_id
      join lateral (
        select s.id, s.title_key, s.isrcs, s.duration_ms, s.mbid, s.merged_into_id, rt.disc, rt.position
        from releases rl join release_tracks rt on rt.release_id = rl.id join recordings s on s.id = rt.recording_id
        where rl.album_id = a.id and rl.id <> ct.release_id
        union all
        select s.id, s.title_key, s.isrcs, s.duration_ms, s.mbid, s.merged_into_id, null, null
        from media_files f join recordings s on s.id = f.recording_id
        where f.album_id = a.id and f.missing_since is null
      ) s on true
      where ct.release_id = ${canonicalRelease('a')} and s.mbid is null and s.merged_into_id is null and s.id <> c.id
        and not exists (select 1 from release_tracks listed where listed.release_id = ct.release_id and listed.recording_id = s.id)
        and (s.title_key = c.title_key or s.isrcs && c.isrcs
          or (s.disc = ct.disc and s.position = ct.position and abs(s.duration_ms - c.duration_ms) <= 2000)))
    -- A daily order keeps albums whose rows are genuinely different songs from holding the batch.
    order by md5(a.id::text || current_date::text) limit ${limit}`)
  return rows.map((row) => row.id)
}

/**
 * Albums with a track that has no present file while a recording of the album's artist with
 * the same title has one elsewhere: the song may be held on another release.
 */
export async function albumsWithHeldCopies(limit = deezerBatch): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.merged_into_id is null and exists (
      select 1 from release_tracks ct join recordings c on c.id = ct.recording_id
      join recordings s on s.title_key = c.title_key and s.primary_artist_id = c.primary_artist_id and s.id <> c.id and s.merged_into_id is null
      where ct.release_id = ${canonicalRelease('a')} and c.merged_into_id is null
        and not exists (select 1 from media_files f where f.recording_id = c.id and f.missing_since is null)
        and exists (select 1 from media_files f where f.recording_id = s.id and f.missing_since is null)
        and not exists (select 1 from release_tracks listed where listed.release_id = ct.release_id and listed.recording_id = s.id))
    order by md5(a.id::text || current_date::text) limit ${limit}`)
  return rows.map((row) => row.id)
}

/** Reads the album's Deezer track list again (`linkDeezerAlbum`). Returns the rows that merged, or null when it could not. */
async function relink(albumId: string): Promise<number | null> {
  const deezerId = await deezerAlbumOf(albumId)
  if (!deezerId) return null
  let merged: number | null = null
  await attempt('album track list', async () => {
    const album = await deezer.getAlbum(Number(deezerId))
    if (album) merged = await linkDeezerAlbum(albumId, album)
  })
  return merged
}

const fitNow = (albumId: string) => db.transaction(async (tx) => {
  await lockUpserts(tx)
  return fitStrayRecordings(tx, albumId)
})

export async function repairAlbumTracks({ deezerEnabled }: { deezerEnabled: boolean }): Promise<AlbumTrackRepair> {
  const report: AlbumTrackRepair = { albums: 0, merged: 0, relinked: 0 }
  const fitted: string[] = []
  for (const albumId of await albumsWithTwins()) {
    const merged = await fitNow(albumId)
    if (merged === 0) continue
    report.albums += 1
    report.merged += merged
    fitted.push(albumId)
  }
  const relinked = new Set<string>()
  if (deezerEnabled) {
    for (const albumId of fitted.slice(0, deezerBatch)) {
      const merged = await relink(albumId)
      if (merged === null) continue
      relinked.add(albumId)
      report.merged += merged
    }
  }
  for (const albumId of await albumsWithHeldCopies()) {
    let merged = 0
    if (deezerEnabled && !relinked.has(albumId) && relinked.size < deezerBatch * 2) {
      const learned = await relink(albumId)
      if (learned !== null) relinked.add(albumId)
      merged += learned ?? 0
    }
    merged += await fitNow(albumId)
    if (merged === 0) continue
    if (!fitted.includes(albumId)) {
      report.albums += 1
      fitted.push(albumId)
    }
    report.merged += merged
  }
  report.relinked = relinked.size
  await changed(fitted.map((albumId) => queryKeys.album(albumId)))
  return report
}
