import { getSql } from '../../database/client.js'
import type { CatalogIndexKind } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'
import { hasUnicode, prefixEnd, readings } from '../search/keys.js'
import { validCatalogSearchIndexes } from './indexes.js'

export type CatalogIndexResult = {
  kind: CatalogIndexKind
  /** Artist, release group or recording MBID. */
  mbid: string
  name: string
  /** The credited artist of an album or recording; null for artists. */
  artistName: string | null
  /** The album a recording is best known from; null for artists and albums. */
  albumName: string | null
  /** Relevance from 0 to 1: text similarity blended with popularity. */
  score: number
  /** The stored popularity alone, 0 to 1. */
  popularity: number
}

export type CatalogIndexSearchOptions = {
  kinds?: CatalogIndexKind[]
  /** Results per kind. Default 10. */
  limit?: number
}

const allKinds: CatalogIndexKind[] = ['artist', 'album', 'recording']
// Fuzzy candidates per kind, taken in popularity order (see below), then re-ranked.
const fuzzyCandidates = 300
// Prefix candidates per kind, taken in key order, so an exact name comes first.
const prefixCandidates = 50
// Low enough that a typo in a short word still matches ("beatels" scores 0.5 against "beatles").
const wordSimilarityThreshold = 0.45

/** True when an import has completed and its index is in place. */
export async function isCatalogIndexReady(): Promise<boolean> {
  const [row] = await getSql()<{ ready: boolean }[]>`
    select exists (select 1 from catalog_index_imports where state = 'active') as ready`
  return row?.ready ?? false
}

/**
 * Searches the local index for artists, albums and recordings, best first, at most
 * `limit` of each kind. Returns nothing when the index is empty.
 *
 * The query and the names are compared as `matchKey`s, so case, punctuation and
 * diacritics never matter. Two kinds of candidates are gathered per kind:
 * - Fuzzy: trigram word similarity against the `head`, the most popular rows of the
 *   kind. This tolerates typos and matches any word, from the first few characters.
 *   The head is small and fixed in size, so this costs a few milliseconds whatever
 *   the size of the dump. Rows are stored in popularity order and read through a
 *   bitmap scan, which returns them in that order, so the candidates taken are the
 *   most popular matches.
 * - Prefix: every row whose whole name starts with the query, from a btree over all
 *   rows, so an exact or nearly complete name finds even the most obscure entry.
 *
 * Candidates are ranked by text quality (similarity, with bonuses when a word starts
 * with the query and when the name is the query, ignoring a leading "the") scaled by
 * popularity, so a famous near match beats an obscure one while an exact name still
 * beats a fuzzy one of similar fame.
 */
export async function searchCatalogIndex(query: string, options: CatalogIndexSearchOptions = {}): Promise<CatalogIndexResult[]> {
  const key = matchKey(query)
  if (!key) return []
  const kinds = options.kinds?.length ? options.kinds : allKinds
  const limit = options.limit ?? 10
  const end = prefixEnd(key)

  return getSql().begin(async (sql) => {
    // A sequential scan would ignore the stored popularity order; parallel workers would interleave it.
    await sql`select set_config('enable_seqscan', 'off', true), set_config('max_parallel_workers_per_gather', '0', true),
                     set_config('pg_trgm.word_similarity_threshold', ${String(wordSimilarityThreshold)}, true)`
    const unicode = hasUnicode(key)
    const splits = readings(key).filter((reading) => reading.context !== null)
    // Without these indexes the extra lookups can scan millions of rows.
    const valid = unicode || (splits.length && kinds.some((kind) => kind !== 'artist'))
      ? await validCatalogSearchIndexes(sql)
      : undefined
    const similarity = unicode
      ? sql`search_unicode_score(search_unicode_bigrams(${key}), search_unicode_bigrams(name_key))`
      : sql`word_similarity(${key}, name_key)`
    const fuzzy = unicode
      ? sql`search_unicode_bigrams(name_key) && search_unicode_bigrams(${key}) and ${similarity} >= 0.5`
      : sql`${key} <% name_key`
    const columns = sql`kind, mbid, name, artist_name, album_name, name_key, score`
    const candidates = kinds.flatMap((kind) => {
      // The kind and head are literals so the planner can use the partial indexes.
      const kindSql = sql.unsafe(`'${kind}'`)
      const byContext = (column: 'artist_name' | 'album_name') => splits.map(({ context, title }) => {
        const field = sql(column)
        const contexts = column === 'artist_name' ? [context, `the ${context}`] : [context]
        return sql`(select ${columns}, case when name_key = ${title} then 1.0 else 0.8 end as composite
          from catalog_index where kind = ${kindSql} and ${field} is not null
            and search_name_key(${field}) collate "C" = any(${contexts}::text[])
            and name_key collate "C" >= ${title} and name_key collate "C" < ${prefixEnd(title)}
          order by name_key collate "C" limit ${prefixCandidates})`
      })
      return [
        ...(!unicode || valid?.has('unicode') ? [
          sql`(select ${columns}, 0.0 as composite from catalog_index
               where kind = ${kindSql} and head and ${fuzzy} limit ${fuzzyCandidates})`,
        ] : []),
        sql`(select ${columns}, 0.0 as composite from catalog_index
             where kind = ${kindSql} and name_key collate "C" >= ${key} and name_key collate "C" < ${end}
             order by kind, name_key collate "C" limit ${prefixCandidates})`,
        ...(kind !== 'artist' && valid?.has('artist_title') ? byContext('artist_name') : []),
        ...(kind === 'recording' && valid?.has('album_title') ? byContext('album_name') : []),
      ]
    })
    const union = candidates.reduce((all, part) => sql`${all} union all ${part}`)
    const rows = await sql<{ kind: CatalogIndexKind; mbid: string; name: string; artist_name: string | null; album_name: string | null; relevance: number; popularity: number }[]>`
      with candidates as (${union}),
      ranked as (
        select distinct on (kind, mbid) kind, mbid, name, artist_name, album_name, score as popularity,
               greatest(composite, 0.8 * ${similarity}
                + 0.1 * (' ' || name_key like ${`% ${key}%`})::int
                + 0.1 * (name_key in (${key}, ${`the ${key}`}))::int) * (0.5 + 0.5 * score) as relevance
        from candidates
        order by kind, mbid, relevance desc
      ),
      limited as (
        select *, row_number() over (partition by kind order by relevance desc, name, mbid) as position from ranked
      )
      select kind, mbid, name, artist_name, album_name, relevance, popularity from limited
      where position <= ${limit}
      order by relevance desc, kind, name`
    return rows.map((row) => ({
      kind: row.kind,
      mbid: row.mbid,
      name: row.name,
      artistName: row.artist_name,
      albumName: row.album_name,
      score: Number(row.relevance),
      popularity: Number(row.popularity),
    }))
  })
}
