/**
 * Shared SQL for "owned": Subsonic only ever shows the user's library. An album is owned
 * when a present file is linked to it, a track when a present file links its recording.
 * A music folder (library root) narrows both to the files of that root.
 */
import { sql, type SQL } from 'drizzle-orm'

/** Condition: a present file (of `rootId`, when given) has `column` equal to the expression `owner`. */
export function hasPresentFile(column: 'album_id' | 'recording_id', owner: string, rootId?: string | null): SQL {
  return sql`exists (
    select 1 from media_files owned where owned.${sql.raw(column)} = ${sql.raw(owner)} and owned.missing_since is null
      ${rootId ? sql`and owned.root_id = ${rootId}` : sql``}
  )`
}

/** Condition on `media_files` alias `f`: present, and in `rootId` when given. */
export function presentFiles(alias: string, rootId?: string | null): SQL {
  return sql`${sql.raw(alias)}.missing_since is null ${rootId ? sql`and ${sql.raw(alias)}.root_id = ${rootId}` : sql``}`
}

/** Condition: the album (alias) carries the genre, ignoring case. */
export function albumHasGenre(album: string, genre: string): SQL {
  return sql`exists (select 1 from unnest(${sql.raw(album)}.genres) as genre where lower(genre) = lower(${genre}))`
}

/** Seconds, as Subsonic counts durations. */
export const seconds = (ms: number | null | undefined) => Math.round((ms ?? 0) / 1000)
