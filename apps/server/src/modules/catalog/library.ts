/**
 * The library lists: owned music only, keyset-paginated.
 *
 * An album is in the library when a present file is linked to it; a track when a present
 * file links to its recording; an artist when it is credited on a library album. Genres
 * match case-insensitively; a track has the genres of its files' albums. Each
 * ordering below is backed by an index in schema.ts, so a page reads about `limit` rows
 * whatever the library size. Each query returns ids and cursor keys; the summary
 * builders hydrate them.
 */
import type { AlbumPage, ArtistPage, GenrePage, GenreSummary, LibraryQuery, LibrarySort, PageQuery, TrackPage } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { badRequest } from '../../lib/errors.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from './pagination.js'
import { sortKeys } from './sql.js'
import { albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

type IdRow = { id: string; cursorKeys: string[] }

/** Condition: the album (alias) carries the genre, ignoring case; `true` without one. */
function hasGenre(album: string, genre: string | undefined): SQL {
  return genre ? sql`exists (select 1 from unnest(${sql.raw(album)}.genres) as genre where lower(genre) = lower(${genre}))` : sql`true`
}

const presentFile = (alias: string, column: string, owner: string) =>
  sql.raw(`exists (select 1 from media_files ${alias} where ${alias}.${column} = ${owner} and ${alias}.missing_since is null)`)

// `recent` walks present files newest first and keeps each album's (or recording's)
// newest file, so it needs no aggregate over the whole library.
const byNewestFile: Ordering['keys'] = [
  { expression: sql.raw('f.added_at'), type: 'timestamptz', descending: true },
  { expression: sql.raw('f.id'), type: 'uuid', descending: true },
]

const albumOrderings: Record<LibrarySort, Ordering> = {
  recent: { name: 'albums:recent', keys: byNewestFile },
  title: {
    name: 'albums:title',
    keys: [
      { expression: sortKeys.title('a'), type: 'text' },
      { expression: sql.raw('a.id'), type: 'uuid' },
    ],
  },
  artist: {
    name: 'albums:artist',
    keys: [
      { expression: sortKeys.credit('a'), type: 'text' },
      { expression: sortKeys.title('a'), type: 'text' },
      { expression: sql.raw('a.id'), type: 'uuid' },
    ],
  },
  year: {
    name: 'albums:year',
    keys: [
      { expression: sql.raw('coalesce(a.year, 0)'), type: 'int', descending: true },
      { expression: sortKeys.title('a'), type: 'text' },
      { expression: sql.raw('a.id'), type: 'uuid' },
    ],
  },
}

/** The query behind `GET /library/albums`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryAlbumsQuery(query: LibraryQuery): SQL {
  const ordering = albumOrderings[query.sort]
  const genre = hasGenre('a', query.genre)
  if (query.sort === 'recent') {
    return sql`
      select f.album_id as id, ${cursorKeys(ordering)}
      from media_files f join albums a on a.id = f.album_id
      where f.missing_since is null and ${genre}
        and not exists (
          select 1 from media_files newer
          where newer.album_id = f.album_id and newer.missing_since is null and (newer.added_at, newer.id) > (f.added_at, f.id)
        )
        and ${after(ordering, query.cursor)}
      order by ${orderBy(ordering)} limit ${query.limit + 1}`
  }
  return sql`
    select a.id, ${cursorKeys(ordering)}
    from albums a
    where ${presentFile('f', 'album_id', 'a.id')} and ${genre} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${query.limit + 1}`
}

/** One page of library albums. */
export async function listLibraryAlbums(query: LibraryQuery): Promise<AlbumPage> {
  const rows = await db.execute<IdRow>(libraryAlbumsQuery(query))
  const ids = rows.slice(0, query.limit).map((row) => row.id)
  return toPage(albumOrderings[query.sort], rows, query.limit, await albumSummaries(ids))
}

const trackOrderings: Record<Exclude<LibrarySort, 'year'>, Ordering> = {
  recent: { name: 'tracks:recent', keys: byNewestFile },
  title: {
    name: 'tracks:title',
    keys: [
      { expression: sortKeys.title('r'), type: 'text' },
      { expression: sortKeys.credit('r'), type: 'text' },
      { expression: sql.raw('r.id'), type: 'uuid' },
    ],
  },
  artist: {
    name: 'tracks:artist',
    keys: [
      { expression: sortKeys.credit('r'), type: 'text' },
      { expression: sortKeys.title('r'), type: 'text' },
      { expression: sql.raw('r.id'), type: 'uuid' },
    ],
  },
}

/** Recordings carry no year, so tracks reject that order with `unsupported_sort`. */
function trackOrdering(sort: LibrarySort): Ordering {
  if (sort === 'year') throw badRequest('Tracks cannot be sorted by year', 'unsupported_sort')
  return trackOrderings[sort]
}

/** The query behind `GET /library/tracks`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryTracksQuery(query: LibraryQuery): SQL {
  const ordering = trackOrdering(query.sort)
  if (query.sort === 'recent') {
    return sql`
      select f.recording_id as id, f.album_id as "albumId", ${cursorKeys(ordering)}
      from media_files f
      where f.missing_since is null and f.recording_id is not null
        and not exists (
          select 1 from media_files newer
          where newer.recording_id = f.recording_id and newer.missing_since is null and (newer.added_at, newer.id) > (f.added_at, f.id)
        )
        and ${query.genre ? sql`exists (select 1 from albums a where a.id = f.album_id and ${hasGenre('a', query.genre)})` : sql`true`}
        and ${after(ordering, query.cursor)}
      order by ${orderBy(ordering)} limit ${query.limit + 1}`
  }
  const owned = query.genre
    ? sql`exists (
        select 1 from media_files f join albums a on a.id = f.album_id
        where f.recording_id = r.id and f.missing_since is null and ${hasGenre('a', query.genre)}
      )`
    : presentFile('f', 'recording_id', 'r.id')
  return sql`
    select r.id, null::uuid as "albumId", ${cursorKeys(ordering)}
    from recordings r
    where ${owned} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${query.limit + 1}`
}

/**
 * One page of library tracks. Sorted by `recent`, each track is shown in the album of
 * its newest file; otherwise the summary builder picks the album.
 */
export async function listLibraryTracks(userId: string, query: LibraryQuery): Promise<TrackPage> {
  const rows = await db.execute<IdRow & { albumId: string | null }>(libraryTracksQuery(query))
  const refs = rows.slice(0, query.limit).map((row) => ({ id: row.id, albumId: row.albumId }))
  return toPage(trackOrdering(query.sort), rows, query.limit, await trackSummaries(userId, refs))
}

const artistOrdering: Ordering = {
  name: 'artists:name',
  keys: [
    { expression: sortKeys.name('ar'), type: 'text' },
    { expression: sql.raw('ar.id'), type: 'uuid' },
  ],
}

/** The query behind `GET /library/artists`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryArtistsQuery(query: PageQuery): SQL {
  return sql`
    select ar.id, ${cursorKeys(artistOrdering)}
    from artists ar
    where exists (
        select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null
        where aa.artist_id = ar.id
      )
      and ${after(artistOrdering, query.cursor)}
    order by ${orderBy(artistOrdering)} limit ${query.limit + 1}`
}

/**
 * One page of the artists credited on library albums, by name ignoring a leading
 * article. The list has this one order and no genre filter.
 */
export async function listLibraryArtists(query: PageQuery): Promise<ArtistPage> {
  const rows = await db.execute<IdRow>(libraryArtistsQuery(query))
  return toPage(artistOrdering, rows, query.limit, await artistSummaries(rows.slice(0, query.limit).map((row) => row.id)))
}

// Spellings of one genre that differ only in case are counted together; the key is the
// lowercased name and the shown name the most common spelling.
const genreOrdering: Ordering = { name: 'genres:name', keys: [{ expression: sql.raw('g.key'), type: 'text' }] }

/** The query behind `GET /library/genres`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryGenresQuery(query: PageQuery): SQL {
  return sql`
    select g.name, g."albumCount", ${cursorKeys(genreOrdering)}
    from (
      select lower(genre) as key, mode() within group (order by genre) as name, count(distinct a.id)::int as "albumCount"
      from albums a cross join unnest(a.genres) as genre
      where ${presentFile('f', 'album_id', 'a.id')}
      group by lower(genre)
    ) g
    where ${after(genreOrdering, query.cursor)}
    order by ${orderBy(genreOrdering)} limit ${query.limit + 1}`
}

/** One page of the genres of library albums with how many library albums carry each. */
export async function listLibraryGenres(query: PageQuery): Promise<GenrePage> {
  const rows = await db.execute<GenreSummary & { cursorKeys: string[] }>(libraryGenresQuery(query))
  return toPage(genreOrdering, rows, query.limit, rows.map((row) => ({ name: row.name, albumCount: row.albumCount })))
}
