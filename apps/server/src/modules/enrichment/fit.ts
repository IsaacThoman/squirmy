/**
 * Folds rows that only stood in for an album's tracks into the recordings of its canonical
 * release, so a song is listed (and owned, and played) once.
 *
 * Stand-ins have no MBID: a search or Deezer top-track stub, a row built from Deezer, the
 * local recording of a file that was filed under the album before its MusicBrainz release
 * was known, or a track of another track list of the album (Deezer's, or one built from a
 * delivery's tags) that the canonical release lists under another row. Deezer's top tracks
 * carry no ISRC, so title and length have to do when there is none. Which track a stand-in
 * is follows `track-identity.ts`.
 */
import { sql } from 'drizzle-orm'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { canonicalRelease } from '../catalog/availability.js'
import { uuidArray } from '../catalog/sql.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeRecording } from '../matching/merge.js'
import type { MbRelease } from '../metadata/musicbrainz.js'
import { editionFreeKey, textArray } from '../search/keys.js'
import { identifyTrack, type TrackRef } from './track-identity.js'

type Stray = TrackRef & {
  /**
   * How it relates to the album. `album`: on another track list of the album or filed under
   * it, so its place and title count even against another ISRC. `owned`: a recording with
   * files elsewhere (the album's single) sharing an ISRC with a track. `loose`: a stub with
   * no file, by ISRC or by its artist.
   */
  kind: 'album' | 'owned' | 'loose'
}

/**
 * Merges each stand-in into the one canonical track it is. Stand-ins are recordings
 * without an MBID that are not on the release, found four ways, each an indexed lookup:
 *
 * - on the album: the recording of a present file whose `album_id` is this album, or a
 *   track of another of its track lists (Deezer's, one built from a delivery's tags).
 *   Matching and acquisition own how files are linked, so an ISRC alone is not enough here:
 *   it must come with the title or the place, and otherwise the title with the place or
 *   the length, or the place with the length (`track-identity.ts`).
 * - owned elsewhere: a recording with files on another album (the single the song
 *   came out on first) that shares an ISRC and the title with exactly one track. The two
 *   rows were one song all along; the files stay on their album.
 * - by ISRC: a recording with no file that shares an ISRC with exactly one track.
 * - loose: a recording with no file and on no release (a search or top-track stub) led by
 *   an artist of the album, fitted by title and length.
 *
 * Then a track with no file of its own joins the copy of its song another release holds
 * (`joinHeldCopies`). Returns how many were merged. Call it under `lockUpserts`.
 */
export async function fitStrayRecordings(tx: Transaction, albumId: string): Promise<number> {
  const tracks = await tx.execute<TrackRef & { artistId: string | null }>(sql`
    select r.id, r.title, r.duration_ms as "durationMs", r.isrcs, r.primary_artist_id as "artistId", rt.disc, rt.position
    from albums a join release_tracks rt on rt.release_id = ${canonicalRelease('a')} join recordings r on r.id = rt.recording_id
    where a.id = ${albumId} and r.merged_into_id is null
    order by rt.disc, rt.position`)
  if (tracks.length === 0) return 0
  const trackIds = uuidArray(tracks.map((track) => track.id))
  const credited = await tx.execute<{ id: string }>(sql`select artist_id as id from album_artists where album_id = ${albumId}`)
  const artistIds = [...new Set([...tracks.flatMap((track) => (track.artistId ? [track.artistId] : [])), ...credited.map((row) => row.id)])]
  const isrcs = [...new Set(tracks.flatMap((track) => track.isrcs))]
  const stub = sql`s.mbid is null and s.merged_into_id is null and not (s.id = any(${trackIds}))`
  const noFiles = sql`not exists (select 1 from media_files f where f.recording_id = s.id)`

  // One row per stand-in and place: the album's own ways in first, so a track of another
  // track list keeps its place.
  const rows = await tx.execute<Stray>(sql`
    select id, title, "durationMs", isrcs, kind, disc, position from (
      select s.id, s.title, s.duration_ms as "durationMs", s.isrcs, 'album' as kind, rt.disc, rt.position, 0 as rank
      from releases rl join release_tracks rt on rt.release_id = rl.id join recordings s on s.id = rt.recording_id
      where rl.album_id = ${albumId} and ${stub}
      union all
      select s.id, s.title, s.duration_ms, s.isrcs, 'album', null, null, 1
      from media_files f join recordings s on s.id = f.recording_id
      where f.album_id = ${albumId} and f.missing_since is null and ${stub}
      ${isrcs.length === 0 ? sql`` : sql`union all
      select s.id, s.title, s.duration_ms, s.isrcs, case when ${noFiles} then 'loose' else 'owned' end, null, null, 2
      from recordings s where s.isrcs && ${textArray(isrcs)} and ${stub}`}
      ${artistIds.length === 0 ? sql`` : sql`union all
      select s.id, s.title, s.duration_ms, s.isrcs, 'loose', null, null, 3
      from recordings s where s.primary_artist_id = any(${uuidArray(artistIds)}) and ${stub} and ${noFiles}
        and not exists (select 1 from release_tracks rt where rt.recording_id = s.id)`}
    ) candidates
    order by rank, id, disc, position`)

  // Every title the album's other track lists and filed files name, for the place rule.
  const listed = await tx.execute<{ title: string }>(sql`
    select rt.title from releases rl join release_tracks rt on rt.release_id = rl.id
    where rl.album_id = ${albumId} and rl.id is distinct from (select ${canonicalRelease('a')} from albums a where a.id = ${albumId})`)
  const titles = new Set([...listed, ...rows.filter((row) => row.kind === 'album')].map((row) => editionFreeKey(row.title)))
  // A stand-in may turn up several ways (on two track lists, and by ISRC): the first way it
  // fits decides.
  const decided = new Map<string, string | null>()
  for (const stray of rows) {
    if (decided.get(stray.id)) continue
    decided.set(stray.id, fit(stray, tracks, titles))
  }
  let merged = 0
  for (const [strayId, into] of decided) {
    if (!into) continue
    await mergeRecording(strayId, into, tx)
    merged += 1
  }
  return merged + await joinHeldCopies(tx, tracks)
}

/**
 * A track with no file of its own whose song another release holds plays that copy, as a
 * streaming app would: ADÉLA's PRIMA lists "Red Bottoms" as MusicBrainz's Dolby Atmos
 * recording, and the server has the stereo song as the recording of the "Red Bottoms"
 * single. The copy is a recording with an MBID (`fitStrayRecordings` folds those without
 * one into the track) and present files, sharing an ISRC and the title with the track and
 * within fifteen seconds of its length (`track-identity.ts`), the only one that does. The
 * track is merged into it: the held recording's MBID is the one that describes the audio,
 * and the track's ids, likes, plays and queue entries follow the redirect. Two MusicBrainz
 * recordings are otherwise never merged; a track with a file of its own keeps it.
 */
async function joinHeldCopies(tx: Transaction, tracks: readonly TrackRef[]): Promise<number> {
  const bare = await tx.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.id = any(${uuidArray(tracks.map((track) => track.id))}) and r.isrcs <> '{}'
      and not exists (select 1 from media_files f where f.recording_id = r.id and f.missing_since is null)`)
  let merged = 0
  for (const { id } of bare) {
    const track = tracks.find((one) => one.id === id)!
    const held = await tx.execute<TrackRef>(sql`
      select s.id, s.title, s.duration_ms as "durationMs", s.isrcs, null::smallint as disc, null::smallint as position
      from recordings s
      where s.isrcs && ${textArray([...track.isrcs])} and s.mbid is not null and s.merged_into_id is null and s.id <> ${id}
        and exists (select 1 from media_files f where f.recording_id = s.id and f.missing_since is null)`)
    const copy = identifyTrack({ ...track, disc: null, position: null }, held)
    if (!copy || !copy.isrcs.some((isrc) => track.isrcs.includes(isrc))) continue
    await mergeRecording(id, copy.id, tx)
    merged += 1
  }
  return merged
}

/** The one track `stray` is, or null when none or several qualify. */
function fit(stray: Stray, tracks: readonly TrackRef[], titles: ReadonlySet<string>): string | null {
  if (stray.kind === 'album') return identifyTrack(stray, tracks, { titles })?.id ?? null
  if (stray.kind === 'owned') {
    // Files elsewhere: only a shared ISRC with the same title moves them under this track.
    const found = identifyTrack({ ...stray, disc: null, position: null }, tracks)
    return found && stray.isrcs.some((isrc) => found.isrcs.includes(isrc)) && editionFreeKey(found.title) === editionFreeKey(stray.title) ? found.id : null
  }
  return identifyTrack(stray, tracks, { isrcAlone: true })?.id ?? null
}

/**
 * The album's own MBID-less recordings that tracks of `release` are, keyed `disc:position`
 * as `upsertRelease` adopts them: a release written onto an album that already has a track
 * list (Deezer's, one built from a delivery's tags, a file filed under it) takes those rows
 * over, so the song keeps the id its likes, plays and queue entries hold, rather than
 * being listed a second time beside them. Only a track and a recording that each find the
 * other and nothing else pair up (`track-identity.ts`).
 */
export async function standInsFor(tx: Transaction, albumId: string, release: MbRelease): Promise<Map<string, { id: string; isrcs: string[] }>> {
  const locals = await tx.execute<TrackRef & { isrcs: string[] }>(sql`
    select s.id, s.title, s.duration_ms as "durationMs", s.isrcs, rt.disc, rt.position
    from releases rl join release_tracks rt on rt.release_id = rl.id join recordings s on s.id = rt.recording_id
    where rl.album_id = ${albumId} and s.mbid is null and s.merged_into_id is null
    union all
    select s.id, s.title, s.duration_ms, s.isrcs, null, null
    from media_files f join recordings s on s.id = f.recording_id
    where f.album_id = ${albumId} and f.missing_since is null and s.mbid is null and s.merged_into_id is null`)
  const adopted = new Map<string, { id: string; isrcs: string[] }>()
  if (locals.length === 0) return adopted
  const incoming: TrackRef[] = release.mediums.flatMap((medium) => medium.tracks.map((track) => ({
    id: `${medium.position}:${track.position}`,
    title: track.title,
    isrcs: track.recording.isrcs,
    durationMs: track.durationMs ?? track.recording.durationMs,
    disc: medium.position,
    position: track.position,
  })))
  const incomingTitles = new Set(incoming.map((track) => editionFreeKey(track.title)))
  const localTitles = new Set(locals.map((local) => editionFreeKey(local.title)))
  const used = new Set<string>()
  for (const track of incoming) {
    // Not an ISRC alone: these rows carry files, and one code on two versions happens.
    const local = identifyTrack(track, locals, { titles: incomingTitles })
    if (!local || used.has(local.id)) continue
    const back = identifyTrack(local, incoming, { titles: localTitles })
    if (back?.id !== track.id) continue
    used.add(local.id)
    adopted.set(track.id, { id: local.id, isrcs: [...local.isrcs] })
  }
  return adopted
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
