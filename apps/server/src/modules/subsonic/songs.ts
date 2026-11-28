/**
 * Builds Subsonic songs (`Child` objects) in batches with a fixed number of queries.
 *
 * Subsonic describes files, so each song is shown through one present file of its
 * recording: the one on the requested album when there is one, then the file the stream
 * endpoint would pick (lossless, then higher bitrate, then newest). The album, disc and
 * track number are that file's. Recordings without a present file are left out.
 */
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { trackCredits, trackExplicit, trackWorks } from '../catalog/credits.js'
import { explicitAllowed } from '../catalog/explicit.js'
import { isoTime, uuidArray } from '../catalog/sql.js'
import { resolveMerged } from '../catalog/redirects.js'
import { normalizationValues } from '../loudness/normalization.js'
import { sonicPoints } from '../sonic/index.js'
import { mimeFor } from '../streaming/index.js'
import { albumId, artistId, coverArtId, trackId } from './ids.js'
import type { Payload } from './protocol.js'
import { seconds, servableArt } from './sql.js'

export type SongRef = { id: string; albumId?: string | null }
export type ArtistCredit = { id: string; name: string }

type SongRow = {
  requestId: string
  requestAlbumId: string | null
  id: string
  mbid: string | null
  title: string
  artistCredit: string
  primaryArtistId: string | null
  isrcs: string[]
  explicit: boolean | null
  comment: string | null
  recordingDurationMs: number | null
  relPath: string
  size: number
  lossless: boolean
  bitrate: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  durationMs: number
  created: string
  tagTrack: unknown
  tagDisc: unknown
  loudnessLufs: number | null
  truePeakDb: number | null
  tagTrackGainDb: number | null
  tagTrackPeak: number | null
  tagAlbumGainDb: number | null
  tagAlbumPeak: number | null
  albumLufs: number | null
  albumPeakDb: number | null
  albumId: string | null
  albumTitle: string | null
  albumCredit: string | null
  albumArtistId: string | null
  year: number | null
  genres: string[] | null
  artworkId: string | null
  disc: number | null
  position: number | null
  starred: string | null
  rating: number | null
  playCount: number
  played: string | null
}

/** Credited artists in credit order, keyed by the owning row. */
export async function credits(table: 'recording_artists' | 'album_artists', ids: readonly string[]): Promise<Map<string, ArtistCredit[]>> {
  if (ids.length === 0) return new Map()
  const owner = table === 'recording_artists' ? 'recording_id' : 'album_id'
  const rows = await db.execute<{ ownerId: string; id: string; name: string }>(sql`
    select ${sql.raw(owner)} as "ownerId", artist_id as id, credited_name as name
    from ${sql.raw(table)} where ${sql.raw(owner)} = any(${uuidArray([...new Set(ids)])})
    order by ${sql.raw(owner)}, position`)
  const result = new Map<string, ArtistCredit[]>()
  for (const row of rows) {
    const list = result.get(row.ownerId) ?? []
    list.push({ id: row.id, name: row.name })
    result.set(row.ownerId, list)
  }
  return result
}

const toArtists = (list: ArtistCredit[]) => list.map((artist) => ({ id: artistId(artist.id), name: artist.name }))
const integer = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

/** OpenSubsonic `replayGain`: always present, with only the values that are known. */
function replayGain(row: SongRow): Payload {
  const values = normalizationValues(row, row.albumLufs === null ? null : { loudnessLufs: row.albumLufs, truePeakDb: row.albumPeakDb! })
  return {
    trackGain: values?.trackGainDb ?? undefined,
    albumGain: values?.albumGainDb ?? undefined,
    trackPeak: values?.trackPeak ?? undefined,
    albumPeak: values?.albumPeak ?? undefined,
  }
}

/**
 * Songs for `refs`, in their order and with duplicates kept. Ids follow merge
 * redirects; ids that do not exist or have no present file are left out, and so are
 * explicit songs (by the file's advisory, else the catalog's) for a user who has explicit
 * content off.
 */
export async function songs(userId: string, refs: readonly SongRef[]): Promise<Payload[]> {
  if (refs.length === 0) return []
  const [recordingIds, albumIds, allowsExplicit] = await Promise.all([
    resolveMerged('recordings', refs.map((ref) => ref.id)),
    resolveMerged('albums', refs.flatMap((ref) => ref.albumId ? [ref.albumId] : [])),
    explicitAllowed(userId),
  ])
  const resolved = refs.flatMap((ref) => {
    const id = recordingIds.get(ref.id)
    return id ? [{ id, albumId: ref.albumId ? albumIds.get(ref.albumId) ?? null : null }] : []
  })
  const pairs = [...new Map(resolved.map((ref) => [`${ref.id}|${ref.albumId ?? ''}`, ref])).values()]
  if (pairs.length === 0) return []

  const rows = await db.execute<SongRow>(sql`
    select req.id as "requestId", req.album_id as "requestAlbumId",
      r.id, r.mbid, r.title, r.artist_credit as "artistCredit", r.primary_artist_id as "primaryArtistId", r.isrcs,
      coalesce((f.tags ->> 'explicit')::boolean, ${trackExplicit(sql`r.id`, sql`r.explicit`, sql`al.id`)}) as explicit,
      f.tags ->> 'comment' as comment,
      r.duration_ms as "recordingDurationMs",
      f.rel_path as "relPath", f.size, f.lossless, f.bitrate, f.sample_rate as "sampleRate", f.bit_depth as "bitDepth",
      f.channels, f.duration_ms as "durationMs", ${isoTime('f.added_at')} as created,
      f.tags -> 'track' as "tagTrack", f.tags -> 'disc' as "tagDisc",
      f.loudness_lufs as "loudnessLufs", f.true_peak_db as "truePeakDb",
      f.tag_track_gain_db as "tagTrackGainDb", f.tag_track_peak as "tagTrackPeak",
      f.tag_album_gain_db as "tagAlbumGainDb", f.tag_album_peak as "tagAlbumPeak",
      rl.loudness_lufs as "albumLufs", rl.true_peak_db as "albumPeakDb",
      al.id as "albumId", al.title as "albumTitle", al.artist_credit as "albumCredit", al.primary_artist_id as "albumArtistId",
      al.year, al.genres, coalesce(${servableArt('al.artwork_asset_id')}, ${servableArt('f.embedded_art_asset_id')}) as "artworkId",
      rt.disc, rt.position,
      ${isoTime('lk.created_at')} as starred, rating.rating,
      coalesce(stats.count, 0)::int as "playCount", ${isoTime('stats.last')} as played
    from unnest(${uuidArray(pairs.map((pair) => pair.id))}, ${uuidArray(pairs.map((pair) => pair.albumId))}) as req(id, album_id)
    join recordings r on r.id = req.id
    join lateral (
      select * from media_files candidate
      where candidate.recording_id = r.id and candidate.missing_since is null
      order by (candidate.album_id = req.album_id) is true desc, candidate.lossless desc,
        candidate.bitrate desc nulls last, candidate.added_at desc
      limit 1
    ) f on true
    left join albums al on al.id = f.album_id
    left join release_tracks rt on rt.id = f.release_track_id
    left join release_loudness rl on rl.release_id = f.release_id
    left join likes lk on lk.user_id = ${userId} and lk.entity_type = 'recording' and lk.entity_id = r.id
    left join ratings rating on rating.user_id = ${userId} and rating.entity_type = 'recording' and rating.entity_id = r.id
    left join lateral (
      select count(*) as count, max(p.started_at) as last from plays p where p.recording_id = r.id and p.user_id = ${userId} and not p.skipped
    ) stats on true`)

  const ids = [...new Set(rows.map((row) => row.id))]
  const [trackArtists, albumArtists, contributors, works, sonic] = await Promise.all([
    credits('recording_artists', ids),
    credits('album_artists', rows.flatMap((row) => row.albumId ? [row.albumId] : [])),
    trackCredits(ids),
    trackWorks(ids),
    sonicPoints(ids),
  ])
  const byPair = new Map(rows.map((row) => [`${row.requestId}|${row.requestAlbumId ?? ''}`, row]))
  return resolved.flatMap((ref) => {
    const row = byPair.get(`${ref.id}|${ref.albumId ?? ''}`)
    // Subsonic clients have no way to gray a song, so explicit ones are left out for a user who has them off.
    if (!row || (row.explicit === true && !allowsExplicit)) return []
    const artists = trackArtists.get(row.id) ?? (row.primaryArtistId ? [{ id: row.primaryArtistId, name: row.artistCredit }] : [])
    const albumCredits = row.albumId
      ? albumArtists.get(row.albumId) ?? (row.albumArtistId ? [{ id: row.albumArtistId, name: row.albumCredit! }] : [])
      : []
    const genres = row.genres ?? []
    const credits = contributors.get(row.id) ?? []
    const compositions = works.get(row.id) ?? []
    const sound = sonic.get(row.id)
    return [{
      id: trackId(row.id),
      parent: row.albumId ? albumId(row.albumId) : undefined,
      isDir: false,
      title: row.title,
      album: row.albumTitle ?? undefined,
      artist: row.artistCredit,
      track: row.position ?? integer(row.tagTrack),
      year: row.year ?? undefined,
      genre: genres[0],
      coverArt: row.artworkId ? coverArtId(row.artworkId) : undefined,
      size: Number(row.size),
      contentType: mimeFor(row),
      suffix: path.extname(row.relPath).slice(1).toLowerCase() || undefined,
      duration: seconds(row.durationMs || row.recordingDurationMs),
      bitRate: row.bitrate ? Math.round(row.bitrate / 1000) : undefined,
      bitDepth: row.bitDepth ?? undefined,
      samplingRate: row.sampleRate ?? undefined,
      channelCount: row.channels ?? undefined,
      path: row.relPath,
      isVideo: false,
      userRating: row.rating ?? undefined,
      playCount: row.playCount,
      discNumber: row.disc ?? integer(row.tagDisc),
      created: row.created,
      starred: row.starred ?? undefined,
      albumId: row.albumId ? albumId(row.albumId) : undefined,
      artistId: artists[0] ? artistId(artists[0].id) : undefined,
      type: 'music',
      mediaType: 'song',
      played: row.played ?? undefined,
      musicBrainzId: row.mbid ?? '',
      bpm: Math.round(sound?.bpm ?? 0),
      moods: sound?.moods ?? [],
      isrc: row.isrcs,
      genres: genres.map((name) => ({ name })),
      artists: toArtists(artists),
      displayArtist: row.artistCredit,
      albumArtists: toArtists(albumCredits),
      displayAlbumArtist: row.albumCredit ?? undefined,
      contributors: credits.map(({ role, artist, instrument }) => ({
        role: role === 'ensemble' ? 'performer' : role,
        subRole: role === 'ensemble' ? 'ensemble' : instrument,
        artist: { id: artistId(artist.id), name: artist.name },
      })),
      displayComposer: [...new Set(credits.filter((credit) => credit.role === 'composer').map((credit) => credit.artist.name))].join(', '),
      works: compositions.map((work) => ({ name: work.title, musicBrainzId: work.mbid ?? undefined })),
      movements: compositions.flatMap((work) => work.movementName || work.movementNumber || work.movementTotal
        ? [{ name: work.movementName ?? row.title, number: work.movementNumber, count: work.movementTotal }] : []),
      comment: row.comment ?? '',
      replayGain: replayGain(row),
      explicitStatus: row.explicit === true ? 'explicit' : row.explicit === false ? 'clean' : '',
    }]
  })
}
