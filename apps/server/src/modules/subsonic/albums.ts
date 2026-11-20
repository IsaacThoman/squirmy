/**
 * Builds Subsonic albums (`AlbumID3`, and the folder form as a `Child`) in batches with
 * a fixed number of queries. Counts, duration and the added date describe the album's
 * present files, one song per recording, as Subsonic clients expect of a library.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { canonicalRelease } from '../catalog/availability.js'
import { isoTime, uuidArray } from '../catalog/sql.js'
import { albumId, artistId, coverArtId } from './ids.js'
import type { Payload } from './protocol.js'
import { credits } from './songs.js'
import { presentFiles, seconds } from './sql.js'

type AlbumRow = {
  id: string
  mbid: string | null
  title: string
  artistCredit: string
  primaryArtistId: string | null
  year: number | null
  releaseDate: string | null
  genres: string[]
  type: string
  secondaryTypes: string[]
  artworkId: string | null
  label: string | null
  songCount: number
  durationMs: number | string
  created: string
  starred: string | null
  rating: number | null
}

const typeNames: Record<string, string> = { ep: 'EP' }
const typeName = (type: string) => typeNames[type] ?? type.charAt(0).toUpperCase() + type.slice(1)

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as an OpenSubsonic ItemDate. */
function itemDate(value: string | null): Payload | undefined {
  const match = value ? /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value) : null
  if (!match) return undefined
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : undefined, day: match[3] ? Number(match[3]) : undefined }
}

export type AlbumOptions = { rootId?: string | null }

/**
 * AlbumID3 objects for `ids`, in their order. Albums with no present file (in the music
 * folder, when one is given) and ids that do not exist are left out.
 */
export async function albums(userId: string, ids: readonly string[], options: AlbumOptions = {}): Promise<Payload[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const [rows, playStats, artists] = await Promise.all([
    db.execute<AlbumRow>(sql`
      select a.id, a.mbid, a.title, a.artist_credit as "artistCredit", a.primary_artist_id as "primaryArtistId", a.year,
        a.release_date as "releaseDate", a.genres, a.type, a.secondary_types as "secondaryTypes",
        a.artwork_asset_id as "artworkId", rel.label,
        stats."songCount", stats."durationMs", ${isoTime('stats.created')} as created,
        ${isoTime('lk.created_at')} as starred, rating.rating
      from albums a
      cross join lateral (
        select count(*)::int as "songCount", coalesce(sum(song.duration_ms), 0)::int8 as "durationMs", min(song.added_at) as created
        from (
          select distinct on (f.recording_id) f.duration_ms, f.added_at from media_files f
          where f.album_id = a.id and f.recording_id is not null and ${presentFiles('f', options.rootId)}
          order by f.recording_id, f.added_at
        ) song
      ) stats
      left join releases rel on rel.id = ${canonicalRelease('a')}
      left join likes lk on lk.user_id = ${userId} and lk.entity_type = 'album' and lk.entity_id = a.id
      left join ratings rating on rating.user_id = ${userId} and rating.entity_type = 'album' and rating.entity_id = a.id
      where a.id = any(${uuidArray(unique)}) and stats."songCount" > 0`),
    db.execute<{ id: string; count: number; last: string }>(sql`
      select album_id as id, count(*)::int as count, ${isoTime('max(started_at)')} as last
      from plays where user_id = ${userId} and album_id = any(${uuidArray(unique)})
      group by album_id`),
    credits('album_artists', unique),
  ])
  const plays = new Map(playStats.map((row) => [row.id, row]))
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    const albumArtists = artists.get(row.id) ?? (row.primaryArtistId ? [{ id: row.primaryArtistId, name: row.artistCredit }] : [])
    const played = plays.get(row.id)
    const types = [row.type, ...row.secondaryTypes]
    return [{
      id: albumId(row.id),
      name: row.title,
      artist: row.artistCredit,
      artistId: albumArtists[0] ? artistId(albumArtists[0].id) : undefined,
      coverArt: row.artworkId ? coverArtId(row.artworkId) : undefined,
      songCount: row.songCount,
      duration: seconds(Number(row.durationMs)),
      playCount: played?.count ?? 0,
      created: row.created,
      starred: row.starred ?? undefined,
      year: row.year ?? undefined,
      genre: row.genres[0],
      played: played?.last,
      userRating: row.rating ?? undefined,
      recordLabels: row.label ? [{ name: row.label }] : [],
      musicBrainzId: row.mbid ?? undefined,
      genres: row.genres.map((name) => ({ name })),
      artists: albumArtists.map((artist) => ({ id: artistId(artist.id), name: artist.name })),
      displayArtist: row.artistCredit,
      releaseTypes: [...new Set(types.map(typeName))],
      originalReleaseDate: itemDate(row.releaseDate),
      isCompilation: types.includes('compilation'),
    }]
  })
}

/** The folder form of an album, for getMusicDirectory, getAlbumList and search2. */
export function albumAsChild(album: Payload): Payload {
  const parent = (album.artists as { id: string }[])[0]?.id
  return {
    id: album.id,
    parent,
    isDir: true,
    title: album.name,
    name: album.name,
    album: album.name,
    artist: album.artist,
    year: album.year,
    genre: album.genre,
    coverArt: album.coverArt,
    songCount: album.songCount,
    duration: album.duration,
    playCount: album.playCount,
    created: album.created,
    starred: album.starred,
    userRating: album.userRating,
    albumId: album.id,
    artistId: album.artistId,
    mediaType: 'album',
    played: album.played,
    musicBrainzId: album.musicBrainzId,
    genres: album.genres,
    artists: album.artists,
    displayArtist: album.displayArtist,
  }
}
