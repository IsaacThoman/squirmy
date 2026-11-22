/**
 * The library lists, keyset-paginated, as one user sees them.
 *
 * A user's library is the server's collection plus what they saved (`inLibraryAlbum` and
 * `inLibraryRecording` in availability.ts, docs/architecture.md "Availability"). An album
 * is in it when a collection file is linked to it or the user saved it; a track when a
 * collection file links its recording, the user saved it, or a present file of it belongs
 * to an album the user saved; an artist when it is credited on a library album. Genres
 * match case-insensitively; a track has the genres of its present files' albums.
 *
 * The title, artist and year orders read the membership set first (collection files by
 * album or recording, the user's saves) and only then the albums or recordings it names,
 * so a catalog full of search stubs costs nothing (performance.test.ts measures both a
 * large collection and a small library in a large catalog). `recent` merges the newest
 * collection file of each item with the user's saves, each walked newest first on its own
 * index. Each query returns ids and cursor keys; the summary builders hydrate them.
 */
import type { AlbumPage, ArtistPage, GenrePage, GenreSummary, LibraryQuery, LibrarySort, PageQuery, TrackPage } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { badRequest } from '../../lib/errors.js'
import { collectionFile } from './availability.js'
import { after, cursorKeys, leadingBound, orderBy, toPage, type Ordering } from './pagination.js'
import { sortKeys } from './sql.js'
import { albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

type IdRow = { id: string; cursorKeys: string[] }

/** Condition: the album (alias) carries the genre, ignoring case; `true` without one. */
function hasGenre(album: string, genre: string | undefined): SQL {
  return genre ? sql`exists (select 1 from unnest(${sql.raw(album)}.genres) as genre where lower(genre) = lower(${genre}))` : sql`true`
}

/**
 * How a title, artist or year page finds its rows. A `small` library (fewer than
 * `SMALL_LIBRARY` albums or tracks) is read from its members, sorted, and cut to a page:
 * cheap however many search stubs the catalog holds. A `large` one walks the catalog's
 * sort index and keeps members, which reads about `limit` rows when most of the catalog
 * is library and stays bounded down to a library of `SMALL_LIBRARY` items.
 */
export type LibraryShape = 'small' | 'large'
const SMALL_LIBRARY = 2000

/** Ids of the albums in the user's library: linked to a collection file, or saved (duplicates possible). */
function libraryAlbumIds(userId: string): SQL {
  return sql`
    select collected.album_id from media_files collected where collected.album_id is not null and ${collectionFile('collected')}
    union all
    select saved.entity_id from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'album'`
}

/** Ids of the recordings in the user's library, by decision 10's three ways in (duplicates possible). */
function libraryRecordingIds(userId: string): SQL {
  return sql`
    select collected.recording_id from media_files collected where collected.recording_id is not null and ${collectionFile('collected')}
    union all
    select saved.entity_id from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'recording'
    union all
    select present.recording_id from library_items saved
      join media_files present on present.album_id = saved.entity_id and present.missing_since is null
    where saved.user_id = ${userId} and saved.entity_type = 'album' and present.recording_id is not null`
}

/**
 * Condition: the album (expression) is in the user's library. Written as one EXISTS over a
 * union so the planner probes the indexes row by row: an OR of two EXISTS is planned as
 * hashed subplans that read every collection file before the first row.
 */
function albumIsMember(album: string, userId: string): SQL {
  return sql`exists (
    select 1 from media_files collected where collected.album_id = ${sql.raw(album)} and ${collectionFile('collected')}
    union all
    select 1 from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'album' and saved.entity_id = ${sql.raw(album)}
  )`
}

/** Condition: the recording (expression) is in the user's library; see `albumIsMember`. */
function recordingIsMember(recording: string, userId: string): SQL {
  return sql`exists (
    select 1 from media_files collected where collected.recording_id = ${sql.raw(recording)} and ${collectionFile('collected')}
    union all
    select 1 from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'recording' and saved.entity_id = ${sql.raw(recording)}
    union all
    select 1 from media_files present join library_items saved
      on saved.user_id = ${userId} and saved.entity_type = 'album' and saved.entity_id = present.album_id
    where present.recording_id = ${sql.raw(recording)} and present.missing_since is null
  )`
}

/** The query behind `libraryShape`: counts members up to the threshold, each source on its own index. Exported for EXPLAIN in tests. */
export function libraryShapeQuery(userId: string, kind: 'albums' | 'tracks'): SQL {
  const column = sql.raw(kind === 'albums' ? 'album_id' : 'recording_id')
  const saves = kind === 'albums'
    ? sql`select saved.entity_id from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'album' limit ${SMALL_LIBRARY}`
    : sql`(select saved.entity_id from library_items saved where saved.user_id = ${userId} and saved.entity_type = 'recording' limit ${SMALL_LIBRARY})
        union all
        (select present.recording_id from library_items saved
          join media_files present on present.album_id = saved.entity_id and present.missing_since is null
        where saved.user_id = ${userId} and saved.entity_type = 'album' limit ${SMALL_LIBRARY})`
  return sql`
    select count(*)::int as count from (
      (select distinct collected.${column} from media_files collected
      where collected.${column} is not null and ${collectionFile('collected')}
      order by collected.${column} limit ${SMALL_LIBRARY})
      union all
      (${saves})
    ) members`
}

/** Whether the user's library lists its albums or tracks from the members or from the catalog's index. */
export async function libraryShape(userId: string, kind: 'albums' | 'tracks'): Promise<LibraryShape> {
  const [row] = await db.execute<{ count: number }>(libraryShapeQuery(userId, kind))
  return row!.count < SMALL_LIBRARY ? 'small' : 'large'
}

/** Newest first, ties by id: the order of `recent`, by when each item entered the library. */
const byRecency = (name: string, at: string, id: string): Ordering => ({
  name,
  keys: [
    { expression: sql.raw(at), type: 'timestamptz', descending: true },
    { expression: sql.raw(id), type: 'uuid', descending: true },
  ],
})

// Renamed from `albums:recent` when the order moved from newest file to newest membership,
// so a cursor from before is refused rather than misread.
const albumsRecent = byRecency('albums:recent2', 'm.at', 'm.id')

const albumOrderings: Record<LibrarySort, Ordering> = {
  recent: albumsRecent,
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

/**
 * The query behind `GET /library/albums`, returning `limit + 1` rows. Exported for EXPLAIN in tests.
 *
 * `recent` places an album at its newest collection file's `added_at` or its save's
 * `created_at`, whichever is later; each branch below keeps only the albums whose time it
 * holds (the collection on a tie), so every album appears once.
 */
export function libraryAlbumsQuery(userId: string, query: LibraryQuery, shape: LibraryShape): SQL {
  const ordering = albumOrderings[query.sort]
  const genre = hasGenre('a', query.genre)
  const limit = query.limit + 1
  if (query.sort === 'recent') {
    const collection = byRecency(ordering.name, 'f.added_at', 'f.album_id')
    const saves = byRecency(ordering.name, 's.created_at', 's.entity_id')
    return sql`
      select m.id, ${cursorKeys(ordering)} from (
        (select f.album_id as id, f.added_at as at
        from media_files f join albums a on a.id = f.album_id
        where ${collectionFile('f')} and ${genre}
          and not exists (
            select 1 from media_files newer
            where newer.album_id = f.album_id and ${collectionFile('newer')} and (newer.added_at, newer.id) > (f.added_at, f.id)
          )
          and not exists (
            select 1 from library_items later
            where later.user_id = ${userId} and later.entity_type = 'album' and later.entity_id = f.album_id and later.created_at > f.added_at
          )
          and ${after(collection, query.cursor)}
        order by ${orderBy(collection)} limit ${limit})
        union all
        (select s.entity_id, s.created_at
        from library_items s join albums a on a.id = s.entity_id
        where s.user_id = ${userId} and s.entity_type = 'album' and ${genre}
          and not exists (
            select 1 from media_files later
            where later.album_id = s.entity_id and ${collectionFile('later')} and later.added_at >= s.created_at
          )
          and ${after(saves, query.cursor)}
        order by ${orderBy(saves)} limit ${limit})
      ) m
      order by ${orderBy(ordering)} limit ${limit}`
  }
  const member = shape === 'small' ? sql`a.id = any(array(${libraryAlbumIds(userId)}))` : albumIsMember('a.id', userId)
  return sql`
    select a.id, ${cursorKeys(ordering)}
    from albums a
    where ${member} and ${genre} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${limit}`
}

/** One page of the user's library albums. */
export async function listLibraryAlbums(userId: string, query: LibraryQuery): Promise<AlbumPage> {
  const shape = query.sort === 'recent' ? 'large' : await libraryShape(userId, 'albums')
  const rows = await db.execute<IdRow>(libraryAlbumsQuery(userId, query, shape))
  const ids = rows.slice(0, query.limit).map((row) => row.id)
  return toPage(albumOrderings[query.sort], rows, query.limit, await albumSummaries(ids))
}

// Renamed from `tracks:recent` for the same reason as `albums:recent2`.
const tracksRecent = byRecency('tracks:recent2', 'm.at', 'm.id')

const trackOrderings: Record<Exclude<LibrarySort, 'year'>, Ordering> = {
  recent: tracksRecent,
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

/** Condition: a present file of the recording (expression) is on an album with the genre; `true` without one. */
function recordingHasGenre(recording: string, genre: string | undefined): SQL {
  if (!genre) return sql`true`
  return sql`exists (
    select 1 from media_files g join albums ga on ga.id = g.album_id
    where g.recording_id = ${sql.raw(recording)} and g.missing_since is null and ${hasGenre('ga', genre)}
  )`
}

/**
 * The query behind `GET /library/tracks`, returning `limit + 1` rows. Exported for EXPLAIN in tests.
 *
 * `recent` places a track at the latest of: its newest collection file's `added_at`, its
 * own save, and the save of an album holding a present file of it. Three branches, one
 * per way in, each keep the tracks whose time they hold (on a tie the collection, then
 * the track's own save), so every track appears once. A track is shown in the album of
 * the branch that placed it: the file's, the saved album, or (saved alone) the summary's choice.
 */
export function libraryTracksQuery(userId: string, query: LibraryQuery, shape: LibraryShape): SQL {
  const ordering = trackOrdering(query.sort)
  const limit = query.limit + 1
  if (query.sort === 'recent') {
    const collection = byRecency(ordering.name, 'f.added_at', 'f.recording_id')
    const ownSaves = byRecency(ordering.name, 's.created_at', 's.entity_id')
    const albumSaves = byRecency(ordering.name, 's.created_at', 'p.recording_id')
    /** Condition: the user saved an album holding a present file of the recording, later than (or at) `than`. */
    const albumSavedAfter = (recording: string, than: string, orEqual: boolean) => sql`exists (
      select 1 from media_files held join library_items album_save
        on album_save.user_id = ${userId} and album_save.entity_type = 'album' and album_save.entity_id = held.album_id
      where held.recording_id = ${sql.raw(recording)} and held.missing_since is null
        and album_save.created_at ${sql.raw(orEqual ? '>=' : '>')} ${sql.raw(than)}
    )`
    return sql`
      select m.id, m."albumId", ${cursorKeys(ordering)} from (
        (select f.recording_id as id, f.album_id as "albumId", f.added_at as at
        from media_files f
        where ${collectionFile('f')} and f.recording_id is not null
          and not exists (
            select 1 from media_files newer
            where newer.recording_id = f.recording_id and ${collectionFile('newer')} and (newer.added_at, newer.id) > (f.added_at, f.id)
          )
          and not exists (
            select 1 from library_items later
            where later.user_id = ${userId} and later.entity_type = 'recording' and later.entity_id = f.recording_id and later.created_at > f.added_at
          )
          and not ${albumSavedAfter('f.recording_id', 'f.added_at', false)}
          and ${recordingHasGenre('f.recording_id', query.genre)}
          and ${after(collection, query.cursor)}
        order by ${orderBy(collection)} limit ${limit})
        union all
        (select s.entity_id, null::uuid, s.created_at
        from library_items s join recordings r on r.id = s.entity_id
        where s.user_id = ${userId} and s.entity_type = 'recording'
          and not exists (
            select 1 from media_files later
            where later.recording_id = s.entity_id and ${collectionFile('later')} and later.added_at >= s.created_at
          )
          and not ${albumSavedAfter('s.entity_id', 's.created_at', false)}
          and ${recordingHasGenre('s.entity_id', query.genre)}
          and ${after(ownSaves, query.cursor)}
        order by ${orderBy(ownSaves)} limit ${limit})
        union all
        (select p.recording_id, s.entity_id, s.created_at
        -- Lateral, so each save is walked newest first and its files are found by album, never by scanning all files.
        from library_items s cross join lateral (
          select distinct file.recording_id from media_files file
          where file.album_id = s.entity_id and file.missing_since is null and file.recording_id is not null
        ) p
        where s.user_id = ${userId} and s.entity_type = 'album' and ${leadingBound(albumSaves, query.cursor)}
          -- A recording on several saved albums is placed by the latest save.
          and not exists (
            select 1 from media_files held join library_items album_save
              on album_save.user_id = ${userId} and album_save.entity_type = 'album' and album_save.entity_id = held.album_id
            where held.recording_id = p.recording_id and held.missing_since is null
              and (album_save.created_at, album_save.entity_id) > (s.created_at, s.entity_id)
          )
          and not exists (
            select 1 from media_files later
            where later.recording_id = p.recording_id and ${collectionFile('later')} and later.added_at >= s.created_at
          )
          and not exists (
            select 1 from library_items own
            where own.user_id = ${userId} and own.entity_type = 'recording' and own.entity_id = p.recording_id and own.created_at >= s.created_at
          )
          and ${recordingHasGenre('p.recording_id', query.genre)}
          and ${after(albumSaves, query.cursor)}
        order by ${orderBy(albumSaves)} limit ${limit})
      ) m
      order by ${orderBy(ordering)} limit ${limit}`
  }
  const member = shape === 'small' ? sql`r.id = any(array(${libraryRecordingIds(userId)}))` : recordingIsMember('r.id', userId)
  return sql`
    select r.id, null::uuid as "albumId", ${cursorKeys(ordering)}
    from recordings r
    where ${member} and ${recordingHasGenre('r.id', query.genre)} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${limit}`
}

/**
 * One page of the user's library tracks. Sorted by `recent`, each track is shown in the
 * album that put it there (see `libraryTracksQuery`); otherwise the summary builder picks the album.
 */
export async function listLibraryTracks(userId: string, query: LibraryQuery): Promise<TrackPage> {
  const ordering = trackOrdering(query.sort)
  const shape = query.sort === 'recent' ? 'large' : await libraryShape(userId, 'tracks')
  const rows = await db.execute<IdRow & { albumId: string | null }>(libraryTracksQuery(userId, query, shape))
  const refs = rows.slice(0, query.limit).map((row) => ({ id: row.id, albumId: row.albumId }))
  return toPage(ordering, rows, query.limit, await trackSummaries(userId, refs))
}

const artistOrdering: Ordering = {
  name: 'artists:name',
  keys: [
    { expression: sortKeys.name('ar'), type: 'text' },
    { expression: sql.raw('ar.id'), type: 'uuid' },
  ],
}

/** The query behind `GET /library/artists`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryArtistsQuery(userId: string, query: PageQuery, shape: LibraryShape): SQL {
  const member = shape === 'small'
    ? sql`ar.id = any(array(select aa.artist_id from album_artists aa where aa.album_id = any(array(${libraryAlbumIds(userId)}))))`
    : sql`exists (select 1 from album_artists aa where aa.artist_id = ar.id and ${albumIsMember('aa.album_id', userId)})`
  return sql`
    select ar.id, ${cursorKeys(artistOrdering)}
    from artists ar
    where ${member}
      and ${after(artistOrdering, query.cursor)}
    order by ${orderBy(artistOrdering)} limit ${query.limit + 1}`
}

/**
 * One page of the artists credited on the user's library albums, by name ignoring a
 * leading article. The list has this one order and no genre filter. Artists only featured
 * on a track are not library artists.
 */
export async function listLibraryArtists(userId: string, query: PageQuery): Promise<ArtistPage> {
  const rows = await db.execute<IdRow>(libraryArtistsQuery(userId, query, await libraryShape(userId, 'albums')))
  return toPage(artistOrdering, rows, query.limit, await artistSummaries(rows.slice(0, query.limit).map((row) => row.id), userId))
}

// Spellings of one genre that differ only in case are counted together; the key is the
// lowercased name and the shown name the most common spelling.
const genreOrdering: Ordering = { name: 'genres:name', keys: [{ expression: sql.raw('g.key'), type: 'text' }] }

/** The query behind `GET /library/genres`, returning `limit + 1` rows. Exported for EXPLAIN in tests. */
export function libraryGenresQuery(userId: string, query: PageQuery, shape: LibraryShape): SQL {
  // Every library album is read either way, so a large library is joined as a set.
  const member = shape === 'small' ? sql`a.id = any(array(${libraryAlbumIds(userId)}))` : sql`a.id in (${libraryAlbumIds(userId)})`
  return sql`
    select g.name, g."albumCount", ${cursorKeys(genreOrdering)}
    from (
      select lower(genre) as key, mode() within group (order by genre) as name, count(distinct a.id)::int as "albumCount"
      from albums a cross join unnest(a.genres) as genre
      where ${member}
      group by lower(genre)
    ) g
    where ${after(genreOrdering, query.cursor)}
    order by ${orderBy(genreOrdering)} limit ${query.limit + 1}`
}

/** One page of the genres of library albums with how many library albums carry each. */
export async function listLibraryGenres(userId: string, query: PageQuery): Promise<GenrePage> {
  const rows = await db.execute<GenreSummary & { cursorKeys: string[] }>(libraryGenresQuery(userId, query, await libraryShape(userId, 'albums')))
  return toPage(genreOrdering, rows, query.limit, rows.map((row) => ({ name: row.name, albumCount: row.albumCount })))
}
