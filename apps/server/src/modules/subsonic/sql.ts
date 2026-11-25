/**
 * Shared SQL for what Subsonic shows. Subsonic apps sync "the library" and play from it
 * without waiting, so their lists are the user's library (the catalog's rule, decision 41
 * in docs/server/subsonic.md: what they saved, plus the server's collection when they
 * turned on `libraryIncludesServerMusic`) narrowed to music with a present file: a file fetched only
 * because someone played it is cache and stays out, or every sampled song would bring its
 * album into these apps. Lookups by id (a song, a stream, a starred or playlist song) only
 * need a present file. A music folder (library root) narrows everything to its files.
 */
import { sql, type SQL } from 'drizzle-orm'
import { collectionCounts, collectionFile, inLibraryAlbum } from '../catalog/availability.js'
import { servable } from '../catalog/summaries.js'

/** Condition on `media_files` alias: present, and in `rootId` when given. */
export function presentFiles(alias: string, rootId?: string | null): SQL {
  return sql`${sql.raw(alias)}.missing_since is null ${rootId ? sql`and ${sql.raw(alias)}.root_id = ${rootId}` : sql``}`
}

/** Condition: a present file (of `rootId`, when given) has `column` equal to the expression `owner`. */
export function hasPresentFile(column: 'album_id' | 'recording_id', owner: string, rootId?: string | null): SQL {
  return sql`exists (
    select 1 from media_files owned where owned.${sql.raw(column)} = ${sql.raw(owner)} and ${presentFiles('owned', rootId)}
  )`
}

/**
 * Whether the server's collection counts as well as the user's library: `library` follows
 * the user's `libraryIncludesServerMusic`; `server` always counts it, for searches with a
 * query, which find all of the server's music as Squirmy's own search does.
 */
export type Reach = 'library' | 'server'

/**
 * Condition on `media_files` alias: a present file (of `rootId`, when given) that puts its
 * track in the user's library: any file whose recording or album the user saved, or a
 * collection file when the collection counts for the user (`collectionCounts`, or always
 * with the `server` reach). A recording has such a file exactly when the catalog's
 * `inLibraryRecording` holds and it has a present file, and asking it of the file lets a
 * collection file pass without a lookup.
 */
export function libraryFile(alias: string, userId: string, rootId?: string | null, reach: Reach = 'library'): SQL {
  const file = sql.raw(alias)
  const counts = reach === 'server' ? sql`true` : collectionCounts(userId)
  return sql`(${presentFiles(alias, rootId)} and ((${counts} and ${collectionFile(alias)}) or exists (
    select 1 from likes kept where kept.user_id = ${userId}
      and ((kept.entity_type = 'recording' and kept.entity_id = ${file}.recording_id)
        or (kept.entity_type = 'album' and kept.entity_id = ${file}.album_id))
  )))`
}

/** Condition: a library file (see `libraryFile`) has `column` equal to the expression `owner`. */
export function hasLibraryFile(column: 'album_id' | 'recording_id', owner: string, userId: string, rootId?: string | null, reach: Reach = 'library'): SQL {
  return sql`exists (
    select 1 from media_files lib where lib.${sql.raw(column)} = ${sql.raw(owner)} and ${libraryFile('lib', userId, rootId, reach)}
  )`
}

/**
 * Condition: the album (expression) is in the user's library by the catalog's rule and has
 * a library file to play. An album the user saved shows once its first file arrives.
 */
export function libraryAlbum(album: string, userId: string, rootId?: string | null, reach: Reach = 'library'): SQL {
  const member = reach === 'server' ? sql`(${inLibraryAlbum(album, userId)} or ${inLibraryAlbum(album, null)})` : inLibraryAlbum(album, userId)
  return sql`(${member} and ${hasLibraryFile('album_id', album, userId, rootId, reach)})`
}

/**
 * `select album_id …`: every library album (see `libraryAlbum`), found from the library
 * files rather than the albums table, so search stubs in the catalog cost nothing.
 */
export function libraryAlbumIds(userId: string, rootId?: string | null): SQL {
  return sql`select candidate.album_id from (
      select distinct f.album_id from media_files f where f.album_id is not null and ${libraryFile('f', userId, rootId)}
    ) candidate
    where ${inLibraryAlbum('candidate.album_id', userId)}`
}

/** Condition: the recording (expression) is a library track with a present file. */
export function libraryRecording(recording: string, userId: string, rootId?: string | null, reach: Reach = 'library'): SQL {
  return hasLibraryFile('recording_id', recording, userId, rootId, reach)
}

/** Condition: the album (alias) carries the genre, ignoring case. */
export function albumHasGenre(album: string, genre: string): SQL {
  return sql`exists (select 1 from unnest(${sql.raw(album)}.genres) as genre where lower(genre) = lower(${genre}))`
}

/** Seconds, as Subsonic counts durations. */
export const seconds = (ms: number | null | undefined) => Math.round((ms ?? 0) / 1000)

/**
 * The asset id in the expression `column` when the art route can serve it, else null: the
 * native summaries' rule (`servable`). A missing asset or a failed download inside its
 * retry window answers 404, and a client given its id asks again on every render. A
 * scalar subquery on the primary key, so it costs one index probe per row.
 */
export function servableArt(column: string): SQL {
  return sql`(select shown.id from assets shown where shown.id = ${sql.raw(column)} and ${servable('shown')})`
}
