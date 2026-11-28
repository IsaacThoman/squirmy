/**
 * Album and song lists. Each query returns ids in list order, `size` rows from `offset`,
 * over the user's library (sql.ts) in the music folder when one is given; the builders
 * then hydrate a page with a fixed number of queries. Starred songs only need a present
 * file: the user picked them, and they play without waiting.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { sortKeys } from '../../catalog/sql.js'
import { albumAsChild, albums } from '../albums.js'
import { artistID3, artistRows, indexArtist } from '../artists.js'
import { rootParam } from '../folders.js'
import { nowPlaying } from '../now-playing.js'
import { invalidParameter, missingParameter, type Context, type Handler, type Params, type Payload } from '../protocol.js'
import { songs } from '../songs.js'
import { albumHasGenre, hasPresentFile, libraryAlbum, libraryAlbumIds, libraryFile } from '../sql.js'

const ids = async (query: SQL) => (await db.execute<{ id: string }>(query)).map((row) => row.id)

/** The ordered album ids of a getAlbumList(2) page. */
async function albumListIds(userId: string, params: Params, rootId: string | undefined): Promise<string[]> {
  const type = params.required('type')
  const size = params.int('size', 10, { min: 0, max: 500 })
  const offset = params.int('offset', 0, { min: 0 })
  const owned = libraryAlbum('a.id', userId, rootId)
  const page = sql`offset ${offset} limit ${size}`
  switch (type) {
    case 'random':
      return ids(sql`select a.id from albums a where ${owned} order by random() limit ${size}`)
    case 'newest':
      return ids(sql`
        select f.album_id as id from media_files f
        where f.album_id in (${libraryAlbumIds(userId, rootId)}) and ${libraryFile('f', userId, rootId)}
        group by f.album_id order by max(f.added_at) desc, f.album_id desc ${page}`)
    case 'alphabeticalByName':
      return ids(sql`select a.id from albums a where ${owned} order by ${sortKeys.title('a')}, a.id ${page}`)
    case 'alphabeticalByArtist':
      return ids(sql`select a.id from albums a where ${owned} order by ${sortKeys.credit('a')}, ${sortKeys.title('a')}, a.id ${page}`)
    case 'byYear': {
      const from = params.int('fromYear')
      const to = params.int('toYear')
      if (from === undefined) throw missingParameter('fromYear')
      if (to === undefined) throw missingParameter('toYear')
      const direction = sql.raw(from > to ? 'desc' : 'asc')
      return ids(sql`
        select a.id from albums a where a.year between ${Math.min(from, to)} and ${Math.max(from, to)} and ${owned}
        order by a.year ${direction}, ${sortKeys.title('a')}, a.id ${page}`)
    }
    case 'byGenre':
      return ids(sql`
        select a.id from albums a where ${albumHasGenre('a', params.required('genre'))} and ${owned}
        order by ${sortKeys.title('a')}, a.id ${page}`)
    case 'starred':
      return ids(sql`
        select a.id from likes l join albums a on a.id = l.entity_id
        where l.user_id = ${userId} and l.entity_type = 'album' and ${owned}
        order by l.created_at desc, a.id ${page}`)
    case 'highest':
      return ids(sql`
        select a.id from ratings r join albums a on a.id = r.entity_id
        where r.user_id = ${userId} and r.entity_type = 'album' and ${owned}
        order by r.rating desc, r.updated_at desc, a.id ${page}`)
    case 'frequent':
    case 'recent':
      return ids(sql`
        select a.id from plays p join albums a on a.id = p.album_id
        where p.user_id = ${userId} and not p.skipped and ${owned}
        group by a.id order by ${sql.raw(type === 'frequent' ? 'count(*) desc, max(p.started_at) desc' : 'max(p.started_at) desc')}, a.id ${page}`)
    default:
      throw invalidParameter('type')
  }
}

async function getRandomSongs({ user, params }: Context): Promise<Payload> {
  const size = params.int('size', 10, { min: 0, max: 500 })
  const genre = params.string('genre')
  const fromYear = params.int('fromYear')
  const toYear = params.int('toYear')
  const rootId = await rootParam(params)
  const filtered = genre !== undefined || fromYear !== undefined || toYear !== undefined
  // One random pass over the library files (a top-N sort, not a full one). A track with
  // several files can come up twice, so a few more are drawn and repeats dropped.
  const picked = await db.execute<{ id: string; albumId: string | null }>(sql`
    select f.recording_id as id, f.album_id as "albumId" from media_files f
    ${filtered ? sql`join albums a on a.id = f.album_id` : sql``}
    where f.recording_id is not null and ${libraryFile('f', user.id, rootId)}
      ${genre ? sql`and ${albumHasGenre('a', genre)}` : sql``}
      ${fromYear !== undefined ? sql`and a.year >= ${fromYear}` : sql``}
      ${toYear !== undefined ? sql`and a.year <= ${toYear}` : sql``}
    order by random() limit ${Math.ceil(size * 1.2) + 5}`)
  const rows = [...new Map(picked.map((row) => [row.id, row])).values()].slice(0, size)
  return { randomSongs: { song: await songs(user.id, rows) } }
}

async function getSongsByGenre({ user, params }: Context): Promise<Payload> {
  const genre = params.required('genre')
  const count = params.int('count', 10, { min: 0, max: 500 })
  const offset = params.int('offset', 0, { min: 0 })
  const rootId = await rootParam(params)
  const rows = await db.execute<{ id: string; albumId: string }>(sql`
    select f.recording_id as id, a.id as "albumId" from media_files f
    join albums a on a.id = f.album_id
    left join release_tracks rt on rt.id = f.release_track_id
    where f.recording_id is not null and ${libraryFile('f', user.id, rootId)} and ${albumHasGenre('a', genre)}
    order by ${sortKeys.title('a')}, a.id, rt.disc nulls last, rt.position nulls last, f.recording_id, f.id
    offset ${offset} limit ${count}`)
  return { songsByGenre: { song: await songs(user.id, rows) } }
}

/** The user's starred artists and albums that are in their library, and starred songs with a present file, newest first. */
async function starred({ user, params, baseUrl }: Context, id3: boolean): Promise<Payload> {
  const rootId = await rootParam(params)
  const liked = (type: 'artist' | 'album' | 'recording') => ids(sql`
    select entity_id as id from likes where user_id = ${user.id} and entity_type = ${type}
    ${type === 'recording' ? sql`and ${hasPresentFile('recording_id', 'entity_id', rootId)}` : sql``}
    order by created_at desc, entity_id`)
  const [artistIds, albumIds, songIds] = await Promise.all([liked('artist'), liked('album'), liked('recording')])
  const [artists, albumList, songList] = await Promise.all([
    artistRows(user.id, artistIds, rootId),
    albums(user.id, albumIds, { rootId }),
    songs(user.id, songIds.map((id) => ({ id }))),
  ])
  return {
    artist: artists.map((row) => id3 ? artistID3(row, baseUrl) : indexArtist(row, baseUrl)),
    album: id3 ? albumList : albumList.map(albumAsChild),
    song: songList,
  }
}

export const listEndpoints: Record<string, Handler> = {
  getAlbumList2: async ({ user, params }) => {
    const rootId = await rootParam(params)
    return { albumList2: { album: await albums(user.id, await albumListIds(user.id, params, rootId), { rootId }) } }
  },
  getAlbumList: async ({ user, params }) => {
    const rootId = await rootParam(params)
    const list = await albums(user.id, await albumListIds(user.id, params, rootId), { rootId })
    return { albumList: { album: list.map(albumAsChild) } }
  },
  getRandomSongs,
  getSongsByGenre,
  getStarred2: async (context) => ({ starred2: await starred(context, true) }),
  getStarred: async (context) => ({ starred: await starred(context, false) }),
  getNowPlaying: async ({ user }) => ({ nowPlaying: { entry: await nowPlaying(user.id) } }),
}
