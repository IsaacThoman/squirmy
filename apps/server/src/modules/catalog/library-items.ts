/**
 * The Library's All (`GET /library/items`): the user's library albums and artists, the
 * playlists they can see and Liked Songs, in one keyset-paginated list.
 *
 * Every kind is its own branch, ordered by the same keys and cut to `limit + 1` after the
 * cursor; the branches are merged and cut again, so a page reads about `limit` rows per
 * kind whatever the library's size. Albums reuse the album list's queries (library.ts);
 * artists walk the same indexes; playlists and Liked Songs are few and are listed whole.
 *
 * `played` (the default) lists what the user started playback from, newest first
 * (`collection_plays`, written by the sessions module), then everything else in the
 * `recent` order. An item's `recent` time is when it entered the library: an album's is
 * its save or, when the collection counts for the user, its newest collection file (library.ts), an artist's the latest of its own
 * save and its library albums' times, a playlist's its creation, Liked Songs' the latest
 * liked song. Under `played` a played item's second key is `-infinity` and a never-played
 * item's first, so the cursor says which part of the list it is in.
 *
 * Pinned items (`library_pins`, written by the userdata module) head the first page, most
 * recently pinned first, and every page leaves them out of the list after them. Each branch
 * reads as many rows more as the user has pins, so a page still fills once they are left out.
 */
import { playlistVisibleTo } from '../userdata/playlist-access.js'
import { LIKED_SONGS_ID, type LibraryItem, type LibraryItemPage, type LibraryItemsQuery, type LibraryItemsSort } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { sortKey } from '../../lib/text.js'
import { playlistSummaries } from '../userdata/playlists.js'
import { collectionCounts, collectionFile } from './availability.js'
import { albumIsMember, hasGenre, libraryAlbumIds, libraryAlbumsQuery, libraryShape, neverPlayed, type LibraryShape } from './library.js'
import { after, cursorKeys, decode, encode, leadingBound, orderBy, toPage, type Ordering, type SortKey } from './pagination.js'
import { isoTime, sortKeys, uuidArray } from './sql.js'
import { albumSummaries, artistSummaries } from './summaries.js'

/** Liked Songs has no row of its own; this id stands for it in the list, in `collection_plays` and in `library_pins`. */
export { LIKED_SONGS_ID }

type Kind = LibraryItem['kind']
type KeyShape = Omit<SortKey, 'expression'>

/** Each order's name (carried by its cursors) and key types; each branch gives its own expressions. */
const orders: Record<LibraryItemsSort, { name: string; keys: KeyShape[] }> = {
  played: {
    name: 'items:played',
    keys: [{ type: 'timestamptz', descending: true }, { type: 'timestamptz', descending: true }, { type: 'uuid', descending: true }],
  },
  recent: { name: 'items:recent', keys: [{ type: 'timestamptz', descending: true }, { type: 'uuid', descending: true }] },
  title: { name: 'items:title', keys: [{ type: 'text' }, { type: 'uuid' }] },
  artist: { name: 'items:artist', keys: [{ type: 'text' }, { type: 'text' }, { type: 'uuid' }] },
  year: { name: 'items:year', keys: [{ type: 'int', descending: true }, { type: 'text' }, { type: 'uuid' }] },
}

function ordering(sort: LibraryItemsSort, expressions: (string | SQL)[]): Ordering {
  const { name, keys } = orders[sort]
  return { name, keys: keys.map((key, index) => ({ ...key, expression: asSql(expressions[index] ?? 'null') })) }
}

const asSql = (expression: string | SQL) => (typeof expression === 'string' ? sql.raw(expression) : expression)

/** The merged list's order, over the typed key columns of `typed`. */
const mergedOrdering = (sort: LibraryItemsSort) => ordering(sort, orders[sort].keys.map((_, index) => `u.k${index + 1}`))

/**
 * A branch as typed key columns `k1..kn` beside `kind` and `id`, from a query that returns
 * `id` and `cursorKeys` (and `kind` when `kind` is not given). `prefix` keys come first,
 * for the never-played part of `played`, which is listed in the `recent` order.
 */
function typed(branch: SQL, types: KeyShape[], options: { kind?: Kind; prefix?: string[] } = {}): SQL {
  const prefix = options.prefix ?? []
  const columns = types.map((key, index) => index < prefix.length
    ? sql.raw(`${prefix[index]}::${key.type} as k${index + 1}`)
    : sql.raw(`(b."cursorKeys"->>${index - prefix.length})::${key.type} as k${index + 1}`))
  const kind = options.kind ? sql`${options.kind}::text` : sql`b.kind`
  return sql`select ${kind} as kind, b.id, ${sql.join(columns, sql`, `)} from (${branch}) b`
}

/** Condition: the artist (expression) is in the user's library: saved, or credited on a library album. */
function artistIsMember(artist: string, userId: string): SQL {
  return sql`(exists (
    select 1 from likes own where own.user_id = ${userId} and own.entity_type = 'artist' and own.entity_id = ${sql.raw(artist)}
  ) or exists (
    select 1 from album_artists credited where credited.artist_id = ${sql.raw(artist)} and ${albumIsMember('credited.album_id', userId)}
  ))`
}

/** Condition: the user may see the playlist (expression). */
function playlistIsVisible(playlist: string, userId: string): SQL {
  return sql`exists (select 1 from playlists visible where visible.id = ${sql.raw(playlist)} and ${playlistVisibleTo(userId, 'visible')})`
}

/** Artists by name (`title`), as creators (`artist`, ahead of their albums) or without a year (`year`). */
function artistsByName(userId: string, sort: 'title' | 'artist' | 'year', cursor: string | undefined, limit: number, shape: LibraryShape): SQL {
  const name = sortKeys.name('ar')
  const own = sql`select own.entity_id from likes own where own.user_id = ${userId} and own.entity_type = 'artist'`
  const member = shape === 'small'
    ? sql`ar.id = any(array(select aa.artist_id from album_artists aa where aa.album_id = any(array(${libraryAlbumIds(userId)})) union all ${own}))`
    : sql`(ar.id in (${own}) or exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${albumIsMember('aa.album_id', userId)}))`
  let order = ordering(sort, sort === 'title' ? [name, 'ar.id'] : [name, "''::text", 'ar.id'])
  if (sort === 'year') {
    // Every artist's year is 0, so the branch is in name order: after an album with a year
    // every artist follows, after an item of year 0 only those past it by name.
    order = { name: orders.year.name, keys: [{ expression: name, type: 'text' }, { expression: sql.raw('ar.id'), type: 'uuid' }] }
    if (cursor) {
      const [year, title, id] = decode(ordering('year', []), cursor)
      cursor = Number(year) > 0 ? undefined : encode(order, [title!, id!])
    }
  }
  const branch = sql`
    select ar.id, ${cursorKeys(order)} from artists ar
    where ${member} and ${leadingBound(order, cursor)} and ${after(order, cursor)}
    order by ${orderBy(order)} limit ${limit}`
  return typed(branch, orders[sort].keys, { kind: 'artist', prefix: sort === 'year' ? ['0'] : [] })
}

/**
 * Artists by when they entered the library, newest first: the latest of the newest
 * collection file on an album crediting them (when the collection counts for the user), the latest save of such an album, and their
 * own save. One walk per way in, each keeping the artists whose time it holds (on a tie the
 * collection, then the album save), so every artist appears once. `unplayed` leaves out
 * the artists the user played from.
 */
function artistsByRecency(userId: string, cursor: string | undefined, limit: number, unplayed: boolean): SQL {
  const played = (artist: string) => (unplayed ? neverPlayed('artist', artist, userId) : sql`true`)
  const files = ordering('recent', ['f.added_at', 'credit.artist_id'])
  const albumSaves = ordering('recent', ['s.created_at', 'credit.artist_id'])
  const ownSaves = ordering('recent', ['s.created_at', 's.entity_id'])
  /** Condition: a collection file on an album crediting the artist, added at or after (`>=`) or after (`>`) `than`. */
  const counts = collectionCounts(userId)
  const fileSince = (artist: string, comparison: '>' | '>=', than: string) => sql`(${counts} and exists (
    select 1 from album_artists other join media_files newer on newer.album_id = other.album_id
    where other.artist_id = ${sql.raw(artist)} and ${collectionFile('newer')} and newer.added_at ${sql.raw(comparison)} ${sql.raw(than)}
  ))`
  /** Condition: the user saved an album crediting the artist at or after (`>=`) or after (`>`) `than`. */
  const albumSavedSince = (artist: string, comparison: '>' | '>=', than: string) => sql`exists (
    select 1 from album_artists other join likes later
      on later.user_id = ${userId} and later.entity_type = 'album' and later.entity_id = other.album_id
    where other.artist_id = ${sql.raw(artist)} and later.created_at ${sql.raw(comparison)} ${sql.raw(than)}
  )`
  const ownSavedAfter = (artist: string, than: string) => sql`exists (
    select 1 from likes own where own.user_id = ${userId} and own.entity_type = 'artist' and own.entity_id = ${sql.raw(artist)} and own.created_at > ${sql.raw(than)}
  )`
  const branch = sql`
    (select credit.artist_id as id, ${cursorKeys(files)}
    from media_files f join album_artists credit on credit.album_id = f.album_id
    where ${collectionFile('f')} and ${counts} and ${leadingBound(files, cursor)}
      -- The artist's newest collection file, by the same tie-break as the album list.
      and not exists (
        select 1 from album_artists other join media_files newer on newer.album_id = other.album_id
        where other.artist_id = credit.artist_id and ${collectionFile('newer')} and (newer.added_at, newer.id) > (f.added_at, f.id)
      )
      and not ${albumSavedSince('credit.artist_id', '>', 'f.added_at')}
      and not ${ownSavedAfter('credit.artist_id', 'f.added_at')}
      and ${played('credit.artist_id')}
      and ${after(files, cursor)}
    order by ${orderBy(files)} limit ${limit})
    union all
    (select credit.artist_id, ${cursorKeys(albumSaves)}
    from likes s join album_artists credit on credit.album_id = s.entity_id
    where s.user_id = ${userId} and s.entity_type = 'album' and ${leadingBound(albumSaves, cursor)}
      and not exists (
        select 1 from album_artists other join likes later
          on later.user_id = ${userId} and later.entity_type = 'album' and later.entity_id = other.album_id
        where other.artist_id = credit.artist_id and (later.created_at, later.entity_id) > (s.created_at, s.entity_id)
      )
      and not ${fileSince('credit.artist_id', '>=', 's.created_at')}
      and not ${ownSavedAfter('credit.artist_id', 's.created_at')}
      and ${played('credit.artist_id')}
      and ${after(albumSaves, cursor)}
    order by ${orderBy(albumSaves)} limit ${limit})
    union all
    (select s.entity_id, ${cursorKeys(ownSaves)}
    from likes s
    where s.user_id = ${userId} and s.entity_type = 'artist' and ${leadingBound(ownSaves, cursor)}
      and not ${fileSince('s.entity_id', '>=', 's.created_at')}
      and not ${albumSavedSince('s.entity_id', '>=', 's.created_at')}
      and ${played('s.entity_id')}
      and ${after(ownSaves, cursor)}
    order by ${orderBy(ownSaves)} limit ${limit})`
  return branch
}

type Collection = { kind: 'playlist' | 'liked'; id: string; title: string; creator: string; at: string | null }

/** The playlists the user can see and Liked Songs, with what each order needs. */
async function collections(userId: string): Promise<Collection[]> {
  const [playlists, liked] = await Promise.all([
    db.execute<{ id: string; name: string; owner: string; at: string }>(sql`
      select p.id, p.name, coalesce(u.display_name, u.username) as owner, ${isoTime('p.created_at')} as at
      from playlists p join users u on u.id = p.owner_id
      where ${playlistVisibleTo(userId)}`),
    db.execute<{ owner: string; at: string | null }>(sql`
      select coalesce(u.display_name, u.username) as owner, (
        select (s.created_at)::text from likes s where s.user_id = u.id and s.entity_type = 'recording' order by s.created_at desc limit 1
      ) as at
      from users u where u.id = ${userId}`),
  ])
  return [
    { kind: 'liked', id: LIKED_SONGS_ID, title: 'Liked Songs', creator: liked[0]?.owner ?? '', at: liked[0]?.at ?? null },
    ...playlists.map((row) => ({ kind: 'playlist' as const, id: row.id, title: row.name, creator: row.owner, at: row.at })),
  ]
}

/** The playlists and Liked Songs as a branch in `sort`'s keys (`recent` keys for the never-played part of `played`). */
function collectionsBranch(userId: string, list: Collection[], sort: LibraryItemsSort, cursor: string | undefined, limit: number): SQL {
  const keys: Record<Exclude<LibraryItemsSort, 'played'>, string[]> = {
    recent: ['v.at', 'v.id'],
    title: ['v.title', 'v.id'],
    artist: ['v.creator', 'v.title', 'v.id'],
    // Cast, as a bare 0 in `order by` would name a column.
    year: ['0::int', 'v.title', 'v.id'],
  }
  const listed = sort === 'played' ? 'recent' : sort
  const order = ordering(listed, keys[listed])
  const rows = sql.join(list.map((item) =>
    sql`(${item.kind}::text, ${item.id}::uuid, ${sortKey(item.title)}::text, ${sortKey(item.creator)}::text, ${item.at ?? '-infinity'}::timestamptz)`), sql`, `)
  const branch = sql`
    select v.kind, v.id, ${cursorKeys(order)} from (values ${rows}) v(kind, id, title, creator, at)
    where ${sort === 'played' ? sql`not exists (
      select 1 from collection_plays played where played.user_id = ${userId} and played.entity_type = v.kind and played.entity_id = v.id
    )` : sql`true`}
      and ${after(order, cursor)}
    order by ${orderBy(order)} limit ${limit}`
  return typed(branch, orders[sort].keys, { prefix: sort === 'played' ? ["'-infinity'"] : [] })
}

/**
 * Condition: the row `alias` (with `entity_type` and `entity_id`, as in `collection_plays` and
 * `library_pins`) names an item the list holds: a library album or artist, a playlist the user
 * can see, or Liked Songs. Under a genre, only a library album of that genre.
 */
export function listsEntry(alias: string, userId: string, genre?: string): SQL {
  const type = sql.raw(`${alias}.entity_type`)
  const id = `${alias}.entity_id`
  return genre
    ? sql`${type} = 'album' and ${albumIsMember(id, userId)}
      and exists (select 1 from albums a where a.id = ${sql.raw(id)} and ${hasGenre('a', genre)})`
    : sql`case ${type}
        when 'album' then ${albumIsMember(id, userId)}
        when 'artist' then ${artistIsMember(id, userId)}
        when 'playlist' then ${playlistIsVisible(id, userId)}
        else ${type} = 'liked'
      end`
}

/** What the user played from and is still in their library (or a playlist they can see), newest first. */
function playedBranch(userId: string, cursor: string | undefined, limit: number, genre: string | undefined): SQL {
  const order = ordering('played', ['p.played_at', "'-infinity'::timestamptz", 'p.entity_id'])
  return typed(sql`
    select p.entity_type as kind, p.entity_id as id, ${cursorKeys(order)} from collection_plays p
    where p.user_id = ${userId} and ${leadingBound(order, cursor)} and ${listsEntry('p', userId, genre)} and ${after(order, cursor)}
    order by ${orderBy(order)} limit ${limit}`, orders.played.keys)
}

type Pin = { kind: Kind; id: string; shows: boolean }

/** The user's pins, most recently pinned first; `shows` when the list holds the item (`listsEntry`). */
async function pins(userId: string, genre: string | undefined): Promise<Pin[]> {
  return db.execute<Pin>(sql`
    select pin.entity_type as kind, pin.entity_id as id, ${listsEntry('pin', userId, genre)} as shows
    from library_pins pin where pin.user_id = ${userId}
    order by pin.pinned_at desc, pin.entity_id desc`)
}

/**
 * The query behind `GET /library/items`, returning `kind`, `id` and `cursorKeys` for `limit + 1`
 * rows, the user's pins left out. `pinCount` is how many pins they have: each branch reads that
 * many rows more, since that many of its rows may be left out. Exported for EXPLAIN in tests.
 */
export async function libraryItemsQuery(userId: string, query: LibraryItemsQuery, pinCount = 0): Promise<SQL> {
  const { sort, genre } = query
  const limit = query.limit + 1 + pinCount
  const albumLimit = query.limit + pinCount
  const branches: SQL[] = []
  // A genre keeps the list to its albums.
  const list = genre ? [] : await collections(userId)
  if (sort === 'played') {
    const values = query.cursor ? decode(ordering('played', []), query.cursor) : undefined
    const neverPart = values?.[0] === '-infinity'
    if (!neverPart) branches.push(playedBranch(userId, query.cursor, limit, genre))
    // The never-played part is the `recent` order; a cursor inside it carries on there.
    const cursor = neverPart ? encode(ordering('recent', []), [values![1]!, values![2]!]) : undefined
    const recent = orders.recent.name
    branches.push(typed(libraryAlbumsQuery(userId, { sort: 'recent', limit: albumLimit, cursor, genre }, 'large', { name: recent, unplayed: true }),
      orders.played.keys, { kind: 'album', prefix: ["'-infinity'"] }))
    if (!genre) {
      branches.push(typed(artistsByRecency(userId, cursor, limit, true), orders.played.keys, { kind: 'artist', prefix: ["'-infinity'"] }))
      branches.push(collectionsBranch(userId, list, 'played', cursor, limit))
    }
  } else if (sort === 'recent') {
    branches.push(typed(libraryAlbumsQuery(userId, { sort, limit: albumLimit, cursor: query.cursor, genre }, 'large', { name: orders.recent.name }),
      orders.recent.keys, { kind: 'album' }))
    if (!genre) {
      branches.push(typed(artistsByRecency(userId, query.cursor, limit, false), orders.recent.keys, { kind: 'artist' }))
      branches.push(collectionsBranch(userId, list, sort, query.cursor, limit))
    }
  } else {
    const shape = await libraryShape(userId, 'albums')
    branches.push(typed(libraryAlbumsQuery(userId, { sort, limit: albumLimit, cursor: query.cursor, genre }, shape, { name: orders[sort].name }),
      orders[sort].keys, { kind: 'album' }))
    if (!genre) {
      branches.push(artistsByName(userId, sort, query.cursor, limit, shape))
      branches.push(collectionsBranch(userId, list, sort, query.cursor, limit))
    }
  }
  const merged = mergedOrdering(sort)
  const unpinned = pinCount === 0 ? sql`true` : sql`not exists (
    select 1 from library_pins pin where pin.user_id = ${userId} and pin.entity_type = u.kind and pin.entity_id = u.id
  )`
  return sql`
    select u.kind, u.id, ${cursorKeys(merged)}
    from (${sql.join(branches.map((branch) => sql`(${branch})`), sql` union all `)}) u
    where ${unpinned}
    order by ${orderBy(merged)} limit ${query.limit + 1}`
}

/** One page of the Library's All; the first starts with the pinned items. */
export async function listLibraryItems(userId: string, query: LibraryItemsQuery): Promise<LibraryItemPage> {
  const pinned = await pins(userId, query.genre)
  const rows = await db.execute<{ kind: Kind; id: string; cursorKeys: string[] }>(await libraryItemsQuery(userId, query, pinned.length))
  const pinnedKeys = new Set(pinned.map((pin) => `${pin.kind}:${pin.id}`))
  const shown = [...(query.cursor ? [] : pinned.filter((pin) => pin.shows)), ...rows.slice(0, query.limit)]
  const ids = (kind: Kind) => shown.filter((row) => row.kind === kind).map((row) => row.id)
  const [albums, artists, playlists, played] = await Promise.all([
    albumSummaries(ids('album')),
    artistSummaries(ids('artist'), userId),
    playlistSummaries(ids('playlist'), userId),
    shown.length === 0 ? [] : db.execute<{ kind: Kind; id: string; at: string }>(sql`
      select entity_type as kind, entity_id as id, ${isoTime('played_at')} as at from collection_plays
      where user_id = ${userId} and entity_id = any(${uuidArray(shown.map((row) => row.id))})`),
  ])
  const byKind = {
    album: new Map(albums.map((album) => [album.id, album])),
    artist: new Map(artists.map((artist) => [artist.id, artist])),
    playlist: new Map(playlists.map((playlist) => [playlist.id, playlist])),
  }
  const playedAt = new Map(played.map((row) => [`${row.kind}:${row.id}`, row.at]))
  const items = shown.flatMap((row): LibraryItem[] => {
    const key = `${row.kind}:${row.id}`
    const at = playedAt.get(key) ?? null
    const pin = pinnedKeys.has(key)
    switch (row.kind) {
      case 'liked': return [{ kind: 'liked', playedAt: at, pinned: pin }]
      case 'album': {
        const album = byKind.album.get(row.id)
        return album ? [{ kind: 'album', album, playedAt: at, pinned: pin }] : []
      }
      case 'artist': {
        const artist = byKind.artist.get(row.id)
        return artist ? [{ kind: 'artist', artist, playedAt: at, pinned: pin }] : []
      }
      case 'playlist': {
        const playlist = byKind.playlist.get(row.id)
        return playlist ? [{ kind: 'playlist', playlist, playedAt: at, pinned: pin }] : []
      }
    }
  })
  // The pins are on top of the page's `limit`, which the cursor is cut at.
  return { items, nextCursor: toPage(mergedOrdering(query.sort), rows, query.limit, []).nextCursor }
}
