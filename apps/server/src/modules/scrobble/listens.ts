import type { ScrobbleTarget } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import type { Executor } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
import { lastfm, listenbrainz } from '../metadata/index.js'

/** What the services are told about one played track. MusicBrainz ids are null when unknown. */
export type PlayedTrack = {
  title: string
  artist: string
  album: string | null
  albumArtist: string | null
  durationMs: number | null
  trackNumber: number | null
  isrc: string | null
  recordingMbid: string | null
  releaseMbid: string | null
  releaseGroupMbid: string | null
  artistMbids: string[]
}

export type TrackRef = { recordingId: string; albumId: string | null }

/**
 * Describes played tracks, aligned with `refs` (a recording that no longer exists gives
 * null). The release is the one the track was played from: on the play's album, then
 * an edition the user owns, then the album's canonical edition.
 */
export async function describeTracks(executor: Executor, refs: readonly TrackRef[]): Promise<(PlayedTrack | null)[]> {
  if (refs.length === 0) return []
  const rows = await executor.execute<PlayedTrack & { index: number }>(sql`
    select k.index::int as index, r.title, r.artist_credit as artist, r.duration_ms as "durationMs", r.isrcs[1] as isrc,
      r.mbid::text as "recordingMbid", t.position as "trackNumber", t.release_mbid as "releaseMbid",
      t.album_title as album, t.album_artist as "albumArtist", t.album_mbid as "releaseGroupMbid",
      array(
        select a.mbid::text from recording_artists ra join artists a on a.id = ra.artist_id
        where ra.recording_id = r.id and a.mbid is not null order by ra.position
      ) as "artistMbids"
    from unnest(${uuidArray(refs.map((ref) => ref.recordingId))}, ${uuidArray(refs.map((ref) => ref.albumId))}) with ordinality as k(recording_id, album_id, index)
    join recordings r on r.id = k.recording_id
    left join lateral (
      select rt.position::int as position, rel.mbid::text as release_mbid, al.title as album_title, al.artist_credit as album_artist, al.mbid::text as album_mbid
      from release_tracks rt join releases rel on rel.id = rt.release_id join albums al on al.id = rel.album_id
      where rt.recording_id = r.id
      order by al.id is not distinct from k.album_id desc,
        exists (select 1 from media_files mf where mf.release_track_id = rt.id and mf.missing_since is null) desc,
        rel.id is not distinct from al.canonical_release_id desc,
        rel.id
      limit 1
    ) t on true`)
  const byIndex = new Map(rows.map(({ index, ...track }) => [index, track]))
  return refs.map((_, index) => byIndex.get(index + 1) ?? null)
}

function listen(track: PlayedTrack, listenedAt?: Date): listenbrainz.LbListen {
  return {
    listenedAt,
    artist: track.artist,
    title: track.title,
    album: track.album ?? undefined,
    recordingMbid: track.recordingMbid ?? undefined,
    releaseMbid: track.releaseMbid ?? undefined,
    releaseGroupMbid: track.releaseGroupMbid ?? undefined,
    artistMbids: track.artistMbids,
    durationMs: track.durationMs ?? undefined,
    trackNumber: track.trackNumber ?? undefined,
    isrc: track.isrc ?? undefined,
  }
}

function lastFmPlay(track: PlayedTrack, startedAt: Date): lastfm.LastFmPlay {
  return {
    artist: track.artist,
    title: track.title,
    album: track.album ?? undefined,
    albumArtist: track.albumArtist ?? undefined,
    durationMs: track.durationMs ?? undefined,
    trackNumber: track.trackNumber ?? undefined,
    mbid: track.recordingMbid ?? undefined,
    startedAt,
  }
}

/**
 * Submits finished plays in one request (callers keep within the service's batch size).
 * Returns false when the service cannot be used on this server right now (Last.fm without
 * an operator key). Throws ProviderError when the service refuses.
 */
export async function submitPlays(target: ScrobbleTarget, credential: string, plays: { track: PlayedTrack; startedAt: Date }[]): Promise<boolean> {
  if (target === 'listenbrainz') {
    await listenbrainz.submitListens(credential, plays.map((play) => listen(play.track, play.startedAt)), plays.length === 1 ? 'single' : 'import')
    return true
  }
  return (await lastfm.scrobble(credential, plays.map((play) => lastFmPlay(play.track, play.startedAt)))) !== null
}

/** Tells the service what is playing now. Throws ProviderError when it refuses. */
export async function submitNowPlaying(target: ScrobbleTarget, credential: string, track: PlayedTrack): Promise<void> {
  if (target === 'listenbrainz') await listenbrainz.submitListens(credential, [listen(track)], 'playing_now')
  else await lastfm.updateNowPlaying(credential, lastFmPlay(track, new Date()))
}
