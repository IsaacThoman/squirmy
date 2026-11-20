/**
 * Small SQL building blocks shared by the catalog and userdata queries. The queries are
 * written as plain SQL over table aliases, so these helpers render text, not columns.
 */
import { sql, type SQL } from 'drizzle-orm'

/** One `uuid[]` parameter, for `= any(...)` and `unnest(...)`. Null entries stay null. */
export function uuidArray(ids: readonly (string | null)[]): SQL {
  return sql`${`{${ids.map((id) => id ?? 'NULL').join(',')}}`}::uuid[]`
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
