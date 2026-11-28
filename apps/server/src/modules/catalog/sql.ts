/**
 * Small SQL building blocks shared by the catalog and userdata queries. The queries are
 * written as plain SQL over table aliases, so these helpers render text, not columns.
 */
import { sql, type SQL } from 'drizzle-orm'
import { specialPurposeArtists } from '../metadata/musicbrainz.js'

/** One `uuid[]` parameter, for `= any(...)` and `unnest(...)`. Null entries stay null. */
export function uuidArray(ids: readonly (string | null)[]): SQL {
  return sql`${`{${ids.map((id) => id ?? 'NULL').join(',')}}`}::uuid[]`
}

/**
 * Whether the artist row (alias given) is one of MusicBrainz's placeholders, Various Artists
 * and the like (`specialPurposeArtists`). Never null, so `not` of it is safe.
 */
export function placeholderArtist(alias: string): SQL {
  return sql`coalesce(${sql.raw(alias)}.mbid = any(${uuidArray([...specialPurposeArtists])}), false)`
}

/** Whether the asset row (alias given) is a remote image, a URL rather than a file of the user's. Never null. */
export function remoteAsset(alias: string): SQL {
  return sql.raw(`coalesce(${alias}.source ~* '^https?://', false)`)
}

/** A timestamptz expression as an ISO 8601 UTC string with milliseconds. */
export function isoTime(expression: string): SQL {
  return sql.raw(`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)
}

/**
 * `lib/text.ts` `sortKey` in SQL, applied to a `*_key` column that already holds
 * `matchKey` text. The same expressions back the sort indexes in schema.ts, so keep the
 * text identical to those.
 */
export const sortKeys = {
  /** Album or recording title, from `title_key`. */
  title: (alias: string) => sql.raw(`regexp_replace(${alias}.title_key, '^(the|a|an) ', '')`),
  /** Album or recording artist credit, from the first half of `match_key`. */
  credit: (alias: string) => sql.raw(`regexp_replace(split_part(${alias}.match_key, '|', 1), '^(the|a|an) ', '')`),
  /** Artist name, from `name_key`. */
  name: (alias: string) => sql.raw(`regexp_replace(${alias}.name_key, '^(the|a|an) ', '')`),
}

/**
 * Which plays count, everywhere plays are counted (Home, history, Subsonic's lists):
 * `listened` is any play but an early skip (Recently played, Jump back in, history,
 * Subsonic `recent`); `completedPlay` one that also passed the scrobble threshold, half
 * the track or four minutes (Most played, top artists, mixes, Rediscover, Subsonic
 * `frequent`). The play row's alias is given.
 */
export const listened = (alias: string) => sql.raw(`not ${alias}.skipped`)
export const completedPlay = (alias: string) => sql.raw(`(${alias}.completed and not ${alias}.skipped)`)

/**
 * The artist a play counts for, over a recording row (alias given): its lead artist, else
 * its first credit, since older rows and catalog stubs can lack one or the other.
 */
export function playArtist(recording: string): SQL {
  return sql.raw(`coalesce(${recording}.primary_artist_id, (
    select ra.artist_id from recording_artists ra where ra.recording_id = ${recording}.id order by ra.position limit 1))`)
}
