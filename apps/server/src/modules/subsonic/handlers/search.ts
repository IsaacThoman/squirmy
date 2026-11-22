/**
 * search3 and search2 over the user's library (sql.ts). A query goes to the search
 * module's library search, so Subsonic apps get the ranking and typo tolerance of
 * Squirmy's own apps; it ranks every track with a present file, so what it finds is kept
 * to the library here. An empty query (or `""`, which several clients send) returns
 * everything, which sync clients page through with the offsets: artists and albums in
 * name order, songs in id order straight off the present-file index.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { matchKey } from '../../../lib/text.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../../catalog/pagination.js'
import { sortKeys, uuidArray } from '../../catalog/sql.js'
import { searchLibrary } from '../../search/library.js'
import { albumAsChild, albums } from '../albums.js'
import { artistID3, artistRows, indexArtist } from '../artists.js'
import { rootParam } from '../folders.js'
import type { Context, Handler, Params, Payload } from '../protocol.js'
import { songs } from '../songs.js'
import { libraryAlbum, libraryFile, libraryRecording } from '../sql.js'

type Page = { count: number; offset: number }
type Kind = 'artist' | 'album' | 'song'

const page = (params: Params, kind: Kind): Page => ({
  count: params.int(`${kind}Count`, 20, { min: 0, max: 500 }),
  offset: params.int(`${kind}Offset`, 0, { min: 0 }),
})

/** Everything of a kind, as `from … where …`, and its order. The last key of each order is unique. */
function listing(kind: Kind, userId: string, rootId?: string): { source: SQL; id: SQL; ordering: Ordering } {
  switch (kind) {
    case 'artist':
      return {
        id: sql`ar.id`,
        source: sql`from artists ar where exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${libraryAlbum('aa.album_id', userId, rootId)})`,
        ordering: { name: 'subsonic:artists', keys: [{ expression: sortKeys.name('ar'), type: 'text' }, { expression: sql.raw('ar.id'), type: 'uuid' }] },
      }
    case 'album':
      return {
        id: sql`a.id`,
        source: sql`from albums a where ${libraryAlbum('a.id', userId, rootId)}`,
        ordering: { name: 'subsonic:albums', keys: [{ expression: sortKeys.title('a'), type: 'text' }, { expression: sql.raw('a.id'), type: 'uuid' }] },
      }
    case 'song':
      return {
        id: sql`f.recording_id`,
        source: sql`from (
          select distinct present.recording_id from media_files present
          where present.recording_id is not null and ${libraryFile('present', userId, rootId)}
        ) f where true`,
        ordering: { name: 'subsonic:songs', keys: [{ expression: sql.raw('f.recording_id'), type: 'uuid' }] },
      }
  }
}

/** Of `ids`, in order, those in the user's library (and the root, when given). */
async function inLibrary(kind: Kind, ids: string[], userId: string, rootId?: string): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<{ id: string }>(kind === 'artist'
    ? sql`select ar.id from artists ar where ar.id = any(${uuidArray(ids)})
        and exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${libraryAlbum('aa.album_id', userId, rootId)})`
    : kind === 'album'
      ? sql`select t.id from albums t where t.id = any(${uuidArray(ids)}) and ${libraryAlbum('t.id', userId, rootId)}`
      : sql`select t.id from recordings t where t.id = any(${uuidArray(ids)}) and ${libraryRecording('t.id', userId, rootId)}`)
  const kept = new Set(rows.map((row) => row.id))
  return ids.filter((id) => kept.has(id))
}

/** One page of each kind for a query, from the search module's ranking. */
async function searchPages(userId: string, key: string, pages: Record<Kind, Page>, rootId?: string): Promise<Record<Kind, string[]>> {
  const limit = Math.max(...Object.values(pages).map(({ count, offset }) => (count === 0 ? 0 : offset + count)))
  if (limit === 0) return { artist: [], album: [], song: [] }
  const found = await searchLibrary(userId, key, limit)
  const pick = async (kind: Kind, ids: string[]) => {
    const { count, offset } = pages[kind]
    if (count === 0) return []
    return (await inLibrary(kind, ids, userId, rootId)).slice(offset, offset + count)
  }
  const [artist, album, song] = await Promise.all([pick('artist', found.artists), pick('album', found.albums), pick('song', found.tracks)])
  return { artist, album, song }
}

/**
 * Where each user's last page of everything ended. Sync clients ask for offset 0, 500,
 * 1000… in turn; the page that starts where the last one ended continues from its last
 * key instead of counting past every earlier row, so deep pages cost what the first does.
 */
const continuations = new Map<string, { offset: number; cursor: string }>()

async function pageIds(userId: string, kind: Kind, { count, offset }: Page, rootId?: string): Promise<string[]> {
  if (count === 0) return []
  const { source, id, ordering } = listing(kind, userId, rootId)
  const slot = `${userId}|${kind}|${rootId ?? ''}`
  const continued = continuations.get(slot)
  const cursor = continued?.offset === offset ? continued.cursor : undefined
  const rows = await db.execute<{ id: string; cursorKeys: string[] }>(sql`
    select ${id} as id, ${cursorKeys(ordering)} ${source} and ${after(ordering, cursor)}
    order by ${orderBy(ordering)} ${cursor ? sql`` : sql`offset ${offset}`} limit ${count + 1}`)
  const next = toPage(ordering, rows, count, rows).nextCursor
  if (continuations.size > 1000) continuations.clear()
  if (next) continuations.set(slot, { offset: offset + count, cursor: next })
  else continuations.delete(slot)
  return rows.slice(0, count).map((row) => row.id)
}

async function everything(userId: string, pages: Record<Kind, Page>, rootId?: string): Promise<Record<Kind, string[]>> {
  const [artist, album, song] = await Promise.all([
    pageIds(userId, 'artist', pages.artist, rootId),
    pageIds(userId, 'album', pages.album, rootId),
    pageIds(userId, 'song', pages.song, rootId),
  ])
  return { artist, album, song }
}

async function search({ user, params }: Context) {
  const query = (params.string('query') ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\*/g, ' ')
  const key = matchKey(query)
  const rootId = await rootParam(params)
  const pages = { artist: page(params, 'artist'), album: page(params, 'album'), song: page(params, 'song') }
  const ids = key ? await searchPages(user.id, key, pages, rootId) : await everything(user.id, pages, rootId)
  const [artistList, albumList, songList] = await Promise.all([
    artistRows(user.id, ids.artist, rootId),
    albums(user.id, ids.album, { rootId }),
    songs(user.id, ids.song.map((id) => ({ id }))),
  ])
  return { artists: artistList, albums: albumList, songs: songList }
}

export const searchEndpoints: Record<string, Handler> = {
  search3: async (context): Promise<Payload> => {
    const found = await search(context)
    return { searchResult3: { artist: found.artists.map((row) => artistID3(row, context.baseUrl)), album: found.albums, song: found.songs } }
  },
  search2: async (context): Promise<Payload> => {
    const found = await search(context)
    return { searchResult2: { artist: found.artists.map((row) => indexArtist(row, context.baseUrl)), album: found.albums.map(albumAsChild), song: found.songs } }
  },
}
