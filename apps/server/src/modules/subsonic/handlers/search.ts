/**
 * search3 and search2 over owned music. Every word of the query must appear in the
 * match key of the name (for albums and songs, the title or the artist credit), so
 * "beatles help" finds Help! by the Beatles. Exact names rank first.
 *
 * The search module will own library search; until it lands this is a small
 * owned-only search of its own. An empty query (or `""`, which several clients send)
 * returns everything, which sync clients page through with the offsets: artists and
 * albums in name order, songs in id order straight off the present-file index.
 */
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { matchKey } from '../../../lib/text.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../../catalog/pagination.js'
import { sortKeys } from '../../catalog/sql.js'
import { albumAsChild, albums } from '../albums.js'
import { artistID3, artistRows, indexArtist } from '../artists.js'
import { rootParam } from '../folders.js'
import type { Context, Handler, Params, Payload } from '../protocol.js'
import { songs } from '../songs.js'
import { hasPresentFile, presentFiles } from '../sql.js'

type Page = { count: number; offset: number }
type Kind = 'artist' | 'album' | 'song'

const page = (params: Params, kind: Kind): Page => ({
  count: params.int(`${kind}Count`, 20, { min: 0, max: 500 }),
  offset: params.int(`${kind}Offset`, 0, { min: 0 }),
})

// Words come from matchKey, so they hold only letters, digits and no LIKE wildcards.
const patterns = (words: string[]) => sql`${`{${words.map((word) => `"%${word}%"`).join(',')}}`}::text[]`

/** What each list holds, as `from … where …`, and its order. The last key of each order is unique. */
function listing(kind: Kind, words: string[], rootId?: string): { source: SQL; id: SQL; ordering: Ordering; rank: SQL } {
  const key = words.join(' ')
  switch (kind) {
    case 'artist':
      return {
        id: sql`ar.id`,
        source: sql`from artists ar where ${words.length ? sql`ar.name_key like all(${patterns(words)})` : sql`true`}
          and exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${hasPresentFile('album_id', 'aa.album_id', rootId)})`,
        ordering: { name: 'subsonic:artists', keys: [{ expression: sortKeys.name('ar'), type: 'text' }, { expression: sql.raw('ar.id'), type: 'uuid' }] },
        rank: sql`(ar.name_key = ${key}) desc`,
      }
    case 'album':
      return {
        id: sql`a.id`,
        source: sql`from albums a where ${words.length ? sql`(a.title_key || ' ' || split_part(a.match_key, '|', 1)) like all(${patterns(words)})` : sql`true`}
          and ${hasPresentFile('album_id', 'a.id', rootId)}`,
        ordering: { name: 'subsonic:albums', keys: [{ expression: sortKeys.title('a'), type: 'text' }, { expression: sql.raw('a.id'), type: 'uuid' }] },
        rank: sql`(a.title_key = ${key}) desc`,
      }
    case 'song':
      // Everything comes straight off the present-file index; a search goes by name.
      return words.length === 0
        ? {
            id: sql`f.recording_id`,
            source: sql`from (
              select distinct present.recording_id from media_files present
              where present.recording_id is not null and ${presentFiles('present', rootId)}
            ) f where true`,
            ordering: { name: 'subsonic:songs', keys: [{ expression: sql.raw('f.recording_id'), type: 'uuid' }] },
            rank: sql``,
          }
        : {
            id: sql`r.id`,
            source: sql`from recordings r where (r.title_key || ' ' || split_part(r.match_key, '|', 1)) like all(${patterns(words)})
              and r.merged_into_id is null and ${hasPresentFile('recording_id', 'r.id', rootId)}`,
            ordering: { name: 'subsonic:songs', keys: [{ expression: sortKeys.title('r'), type: 'text' }, { expression: sortKeys.credit('r'), type: 'text' }, { expression: sql.raw('r.id'), type: 'uuid' }] },
            rank: sql`(r.title_key = ${key}) desc`,
          }
  }
}

/**
 * Where each user's last page of everything ended. Sync clients ask for offset 0, 500,
 * 1000… in turn; the page that starts where the last one ended continues from its last
 * key instead of counting past every earlier row, so deep pages cost what the first does.
 */
const continuations = new Map<string, { offset: number; cursor: string }>()

async function pageIds(userId: string, kind: Kind, words: string[], { count, offset }: Page, rootId?: string): Promise<string[]> {
  if (count === 0) return []
  const { source, id, ordering, rank } = listing(kind, words, rootId)
  if (words.length > 0) {
    const rows = await db.execute<{ id: string }>(sql`select ${id} as id ${source} order by ${rank}, ${orderBy(ordering)} offset ${offset} limit ${count}`)
    return rows.map((row) => row.id)
  }
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

async function search({ user, params }: Context) {
  const query = (params.string('query') ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\*/g, ' ')
  const key = matchKey(query)
  const words = key ? key.split(' ') : []
  const rootId = await rootParam(params)
  const [artistIds, albumIds, songIds] = await Promise.all([
    pageIds(user.id, 'artist', words, page(params, 'artist'), rootId),
    pageIds(user.id, 'album', words, page(params, 'album'), rootId),
    pageIds(user.id, 'song', words, page(params, 'song'), rootId),
  ])
  const [artistList, albumList, songList] = await Promise.all([
    artistRows(user.id, artistIds, rootId),
    albums(user.id, albumIds, { rootId }),
    songs(user.id, songIds.map((id) => ({ id }))),
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
