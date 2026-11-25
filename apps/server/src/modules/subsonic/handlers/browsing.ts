/**
 * Browsing, by ID3 tags (getArtists, getArtist, getAlbum, getSong…) and by folders for
 * older clients (getIndexes, getMusicDirectory), both over the same ids: an artist is a
 * folder of albums, an album a folder of songs. Lists are the user's library (sql.ts);
 * `getSong` finds any song with a present file, as streams do.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { matchKey } from '../../../lib/text.js'
import { albumTrackList } from '../../catalog/pages.js'
import { resolveOne, type MergeableTable } from '../../catalog/redirects.js'
import { uuidArray } from '../../catalog/sql.js'
import { similarArtists } from '../../radio/index.js'
import { suggestAutoplay } from '../../radio/suggest.js'
import { albumAsChild, albums } from '../albums.js'
import { allLibraryArtists, artistID3, artistRows, artUrl, IGNORED_ARTICLES, indexArtist, indexByLetter } from '../artists.js'
import { rootParam } from '../folders.js'
import { albumId, artistId, expectId, trackId, type IdKind } from '../ids.js'
import { notFound, type Context, type Handler, type Payload } from '../protocol.js'
import { songs } from '../songs.js'
import { libraryAlbum, libraryAlbumIds, libraryFile, libraryRecording, presentFiles, servableArt } from '../sql.js'

const tables: Partial<Record<IdKind, MergeableTable>> = { artist: 'artists', album: 'albums', track: 'recordings' }
const nouns: Partial<Record<IdKind, string>> = { artist: 'Artist', album: 'Album', track: 'Song' }

/** The current id of a parsed id after merges; error 70 when it does not exist. */
export async function resolve(kind: 'artist' | 'album' | 'track', id: string): Promise<string> {
  const resolved = await resolveOne(tables[kind]!, id)
  if (!resolved) throw notFound(nouns[kind]!)
  return resolved
}

/**
 * Albums the artist is an album artist of, oldest first: in the user's library or the
 * server's collection, as a lookup by id reaches (`server`).
 */
async function artistAlbumIds(userId: string, artist: string, rootId?: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.id in (select aa.album_id from album_artists aa where aa.artist_id = ${artist}) and ${libraryAlbum('a.id', userId, rootId, 'server')}
    order by a.year nulls last, a.release_date nulls last, a.title_key, a.id`)
  return rows.map((row) => row.id)
}

/**
 * Library and collection songs filed under an album, in the order of the catalog's track list. Songs the release does
 * not number (bonus tracks) are numbered after the last track of their disc, so clients that
 * sort by number put them last and no two songs share one.
 */
async function albumSongs(userId: string, album: string): Promise<Payload[]> {
  const [listed, filed] = await Promise.all([
    albumTrackList(album),
    db.execute<{ id: string }>(sql`
      select distinct f.recording_id as id from media_files f
      where f.album_id = ${album} and f.recording_id is not null and ${libraryFile('f', userId, undefined, 'server')}`),
  ])
  // The songs whose files are filed under this album.
  const own = new Set(filed.map((row) => row.id))
  const tracks = listed.filter((track) => own.has(track.recordingId))
  const list = await songs(userId, tracks.map((track) => ({ id: track.recordingId, albumId: album })))
  const byId = new Map(list.map((song) => [song.id, song]))
  const last = new Map<number, number>()
  for (const track of tracks) if (track.position !== null) last.set(track.disc, Math.max(last.get(track.disc) ?? 0, track.position))
  return tracks.flatMap((track) => {
    const song = byId.get(trackId(track.recordingId))
    if (!song) return []
    const position = track.position ?? (last.get(track.disc) ?? 0) + 1
    last.set(track.disc, Math.max(last.get(track.disc) ?? 0, position))
    return [{ ...song, discNumber: track.disc, track: position }]
  })
}

async function getArtistPayload({ user, params, baseUrl }: Context) {
  const artist = await resolve('artist', expectId(params.required('id'), 'artist').id)
  const [row] = await artistRows(user.id, [artist], undefined, 'server')
  if (!row) throw notFound('Artist')
  return { row, albums: await albums(user.id, await artistAlbumIds(user.id, artist), { reach: 'server' }), baseUrl }
}

async function getAlbum({ user, params }: Context): Promise<Payload> {
  const album = await resolve('album', expectId(params.required('id'), 'album').id)
  const [summary] = await albums(user.id, [album], { reach: 'server' })
  if (!summary) throw notFound('Album')
  return { album: { ...summary, song: await albumSongs(user.id, album) } }
}

async function getMusicDirectory(context: Context): Promise<Payload> {
  const { user, params } = context
  const parsed = expectId(params.required('id'), 'artist', 'album')
  if (parsed.kind === 'artist') {
    const { row, albums: list } = await getArtistPayload(context)
    return { directory: { id: artistId(row.id), name: row.name, starred: row.starred ?? undefined, userRating: row.rating ?? undefined, child: list.map(albumAsChild) } }
  }
  const album = await resolve('album', parsed.id)
  const [summary] = await albums(user.id, [album], { reach: 'server' })
  if (!summary) throw notFound('Album')
  return {
    directory: {
      id: albumId(album),
      parent: (summary.artists as { id: string }[])[0]?.id,
      name: summary.name,
      starred: summary.starred,
      userRating: summary.userRating,
      playCount: summary.playCount,
      child: await albumSongs(user.id, album),
    },
  }
}

async function getIndexes({ user, params, baseUrl }: Context): Promise<Payload> {
  const rootId = await rootParam(params)
  // A save changes the index as much as a scanned file does.
  const [changed] = await db.execute<{ at: string | null }>(sql`
    select (extract(epoch from greatest(
      (select max(f.updated_at) from media_files f where ${libraryFile('f', user.id, rootId)}),
      (select max(kept.created_at) from likes kept where kept.user_id = ${user.id})
    )) * 1000)::int8::text as at`)
  const lastModified = Number(changed?.at ?? 0)
  const since = params.int('ifModifiedSince')
  if (since !== undefined && since >= lastModified) return { indexes: { lastModified, ignoredArticles: IGNORED_ARTICLES } }
  const rows = await allLibraryArtists(user.id, rootId)
  return { indexes: { lastModified, ignoredArticles: IGNORED_ARTICLES, index: indexByLetter(rows, (row) => indexArtist(row, baseUrl)) } }
}

/** The artist an artist, album or song id leads to: itself, or the primary artist. */
async function artistOf(value: string): Promise<string> {
  const parsed = expectId(value, 'artist', 'album', 'track')
  const id = await resolve(parsed.kind, parsed.id)
  if (parsed.kind === 'artist') return id
  const table = parsed.kind === 'album' ? sql.raw('albums') : sql.raw('recordings')
  const [row] = await db.execute<{ artistId: string | null }>(sql`select primary_artist_id as "artistId" from ${table} where id = ${id}`)
  if (!row?.artistId) throw notFound('Artist')
  return row.artistId
}

/**
 * Biography, images and similar artists. Similar artists come from the radio module and
 * are always library artists: `includeNotPresent` is ignored, as nothing catalog-only is shown.
 */
async function artistInfo({ user, params, baseUrl }: Context, id3: boolean): Promise<Payload> {
  const artist = await artistOf(params.required('id'))
  const count = params.int('count', 20, { min: 0, max: 100 })
  const [[row], similar] = await Promise.all([
    db.execute<{ bio: string | null; bioUrl: string | null; mbid: string | null; imageId: string | null }>(sql`
      select bio, bio_url as "bioUrl", mbid, ${servableArt('image_asset_id')} as "imageId" from artists where id = ${artist}`),
    count > 0 ? similarArtists(artist, { limit: count * 2 }) : [],
  ])
  if (!row) throw notFound('Artist')
  const owned = (await artistRows(user.id, similar.map((one) => one.artistId))).slice(0, count)
  return {
    biography: row.bio ?? undefined,
    musicBrainzId: row.mbid ?? undefined,
    lastFmUrl: row.bioUrl?.includes('last.fm') ? row.bioUrl : undefined,
    smallImageUrl: row.imageId ? artUrl(baseUrl, row.imageId, 300) : undefined,
    mediumImageUrl: row.imageId ? artUrl(baseUrl, row.imageId, 600) : undefined,
    largeImageUrl: row.imageId ? artUrl(baseUrl, row.imageId, 1200) : undefined,
    similarArtist: owned.map((one) => id3 ? artistID3(one, baseUrl) : indexArtist(one, baseUrl)),
  }
}

async function albumInfo({ params, baseUrl }: Context): Promise<Payload> {
  const parsed = expectId(params.required('id'), 'album', 'track')
  const id = await resolve(parsed.kind, parsed.id)
  const [row] = await db.execute<{ description: string | null; mbid: string | null; artworkId: string | null }>(parsed.kind === 'album'
    ? sql`select description, mbid, ${servableArt('artwork_asset_id')} as "artworkId" from albums where id = ${id}`
    : sql`select a.description, a.mbid, ${servableArt('a.artwork_asset_id')} as "artworkId" from media_files f join albums a on a.id = f.album_id
        where f.recording_id = ${id} and f.missing_since is null order by f.added_at desc limit 1`)
  if (!row) throw notFound('Album')
  return {
    notes: row.description ?? undefined,
    musicBrainzId: row.mbid ?? undefined,
    smallImageUrl: row.artworkId ? artUrl(baseUrl, row.artworkId, 300) : undefined,
    mediumImageUrl: row.artworkId ? artUrl(baseUrl, row.artworkId, 600) : undefined,
    largeImageUrl: row.artworkId ? artUrl(baseUrl, row.artworkId, 1200) : undefined,
  }
}

/** Library tracks credited to the artist, most played on this server first, then most popular. */
async function topTrackIds(userId: string, artist: string, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.id in (
        select ra.recording_id from recording_artists ra where ra.artist_id = ${artist}
        union select led.id from recordings led where led.primary_artist_id = ${artist}
      )
      and r.merged_into_id is null and ${libraryRecording('r.id', userId)}
    order by (select count(*) from plays p where p.recording_id = r.id and p.completed) desc,
      r.popularity desc nulls last, r.title_key, r.id
    limit ${limit}`)
  return rows.map((row) => row.id)
}

async function getTopSongs({ user, params }: Context): Promise<Payload> {
  const count = params.int('count', 50, { min: 0, max: 500 })
  let artist: string | undefined
  if (params.has('id')) {
    artist = await resolve('artist', expectId(params.required('id'), 'artist').id)
  } else {
    // By name: the artist with that name, preferring one with library albums.
    const [row] = await db.execute<{ id: string }>(sql`
      select ar.id from artists ar where ar.name_key = ${matchKey(params.required('artist'))} and ar.merged_into_id is null
      order by exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${libraryAlbum('aa.album_id', user.id)}) desc, ar.id
      limit 1`)
    artist = row?.id
  }
  const ids = artist ? await topTrackIds(user.id, artist, count) : []
  return { topSongs: { song: await songs(user.id, ids.map((id) => ({ id }))) } }
}

/**
 * Songs like the given artist, album or song: the radio module's suggestions from its
 * tracks that are in the library, or, while there are none, random library tracks by the
 * same artist.
 */
async function similarSongs({ user, params }: Context): Promise<Payload[]> {
  const parsed = expectId(params.required('id'), 'artist', 'album', 'track')
  const count = params.int('count', 50, { min: 0, max: 500 })
  const id = await resolve(parsed.kind, parsed.id)
  const artist = await artistOf(params.required('id'))
  const seeds = parsed.kind === 'track' ? [id]
    : parsed.kind === 'album' ? (await db.execute<{ id: string }>(sql`
        select distinct f.recording_id as id from media_files f where f.album_id = ${id} and f.recording_id is not null and ${presentFiles('f')}`)).map((row) => row.id)
    : await topTrackIds(user.id, id, 10)
  // Like a song or an album means other songs; like an artist may include its own.
  const exclude = parsed.kind === 'artist' ? [] : seeds
  const suggested = count > 0 ? await suggestAutoplay({ userId: user.id, seeds, exclude, limit: count }) : []
  // Radio suggests what this user can play, which can be music to fetch or cached files.
  const kept = suggested.length === 0 ? new Set<string>() : new Set((await db.execute<{ id: string }>(sql`
    select r.id from recordings r where r.id = any(${uuidArray(suggested.map((seed) => seed.trackId))})
      and ${libraryRecording('r.id', user.id)}`)).map((row) => row.id))
  const inLibrary = suggested.filter((seed) => kept.has(seed.trackId))
  if (inLibrary.length > 0) return songs(user.id, inLibrary.map((seed) => ({ id: seed.trackId, albumId: seed.albumId })))
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.id in (select ra.recording_id from recording_artists ra where ra.artist_id = ${artist})
      and r.id <> all(${`{${exclude.join(',')}}`}::uuid[]) and ${libraryRecording('r.id', user.id)}
    order by random() limit ${count}`)
  return songs(user.id, rows.map((row) => ({ id: row.id })))
}

/** Genres of library albums. A song counts once per album it is on. */
async function getGenres({ user }: Context): Promise<Payload> {
  const rows = await db.execute<{ value: string; songCount: number; albumCount: number }>(sql`
    with owned as (
      select f.album_id, count(distinct f.recording_id)::int as songs from media_files f
      where f.album_id in (${libraryAlbumIds(user.id)}) and ${libraryFile('f', user.id)} group by f.album_id
    )
    select mode() within group (order by genre) as value, sum(owned.songs)::int as "songCount", count(*)::int as "albumCount"
    from owned join albums a on a.id = owned.album_id cross join unnest(a.genres) as genre
    group by lower(genre) order by lower(genre)`)
  return { genres: { genre: rows } }
}

export const browsingEndpoints: Record<string, Handler> = {
  getArtists: async ({ user, params, baseUrl }) => {
    const rows = await allLibraryArtists(user.id, await rootParam(params))
    return { artists: { ignoredArticles: IGNORED_ARTICLES, index: indexByLetter(rows, (row) => artistID3(row, baseUrl)) } }
  },
  getArtist: async (context) => {
    const { row, albums: list, baseUrl } = await getArtistPayload(context)
    return { artist: { ...artistID3(row, baseUrl), album: list } }
  },
  getAlbum,
  getSong: async ({ user, params }) => {
    const [song] = await songs(user.id, [{ id: await resolve('track', expectId(params.required('id'), 'track').id) }])
    if (!song) throw notFound('Song')
    return { song }
  },
  getGenres,
  getArtistInfo: async (context) => ({ artistInfo: await artistInfo(context, false) }),
  getArtistInfo2: async (context) => ({ artistInfo2: await artistInfo(context, true) }),
  getAlbumInfo: async (context) => ({ albumInfo: await albumInfo(context) }),
  getAlbumInfo2: async (context) => ({ albumInfo: await albumInfo(context) }),
  getTopSongs,
  getSimilarSongs: async (context) => ({ similarSongs: { song: await similarSongs(context) } }),
  getSimilarSongs2: async (context) => ({ similarSongs2: { song: await similarSongs(context) } }),
  getIndexes,
  getMusicDirectory,
}
