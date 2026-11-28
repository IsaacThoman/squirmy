/**
 * Search over the user's Library membership, including saved music without files yet.
 * Global search can also look up everything with a present file on the server.
 *
 * The query is a `matchKey`, so case, punctuation and diacritics never matter. Candidates
 * come from three index lookups per kind, each bounded:
 * - prefix: names or titles starting with the query (a byte-order btree), and for every
 *   split of its words into "artist title" or "title artist", titles starting with one
 *   part by the artist named by the other, so `radiohead karma` finds Karma Police;
 * - artist: albums and tracks whose primary artist's name starts with the query;
 * - fuzzy (three characters or more): trigram word similarity against `name_key` or the
 *   whole `match_key` (artist and title), which tolerates typos and word order.
 * Only rows in scope are taken, and one more lookup walks the user's saves (a few hundred rows
 * for most people) for titles or names that start with the query or are like it. They are ranked exact match first, then prefix (of a title,
 * a name or the artist), then by similarity; ties go to what the user played most among
 * their last 1,000 plays, then to what they liked.
 */
import { hasSearchFacets, type SearchFacets } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordingOwned } from '../catalog/availability.js'
import { albumIsMember, recordingIsMember } from '../catalog/library.js'
import { searchFacetConditions } from './facets.js'
import { hasUnicode, prefixEnd, readings, textArray } from './keys.js'

export type LibraryKind = 'artist' | 'album' | 'track'

const prefixCandidates = 50
const fuzzyCandidates = 200
/** Plays considered for tie-breaks, newest first. Bounds the cost for long histories. */
const recentPlays = 1000

const readingsTable = (list: ReturnType<typeof readings>) => sql`
  select * from unnest(${textArray(list.map((one) => one.title))}, ${textArray(list.map((one) => prefixEnd(one.title)))},
                       ${textArray(list.map((one) => one.context))}) as k(title, title_end, context)`

/** The artist half of `match_key` is the reading's artist, maybe after "the" and before "feat. …". */
const creditMatches = (alias: string) => sql.raw(`(k.context is null or (split_part(${alias}.match_key, '|', 1) || ' ') like any (array[k.context || ' %', 'the ' || k.context || ' %']))`)

/**
 * Fuzzy candidates are looked up by the query's first words, up to this many characters:
 * every trigram adds a posting list to merge, and a few words find the candidates.
 * Ranking still uses the whole query.
 */
const fuzzyKeyLength = 24

function fuzzy(key: string, column: SQL): SQL {
  if (hasUnicode(key)) {
    return sql`search_unicode_bigrams(${column}) && search_unicode_bigrams(${key})
      and ${similarity(key, column)} >= 0.5`
  }
  if (key.length < 3) return sql`false`
  let lookup = key
  if (key.length > fuzzyKeyLength) {
    const cut = key.lastIndexOf(' ', fuzzyKeyLength)
    lookup = key.slice(0, cut > 0 ? cut : fuzzyKeyLength)
  }
  return sql`${lookup} <% ${column} and cardinality(show_trgm(${lookup})) > 0`
}

function similarity(key: string, column: SQL): SQL {
  return hasUnicode(key)
    ? sql`search_unicode_score(search_unicode_bigrams(${key}), search_unicode_bigrams(${column}))`
    : sql`word_similarity(${key}, ${column})`
}

/**
 * SQL condition: the artist `alias` is credited on an owned recording or on an album with
 * a present file. One exists over a union rather than two joined by `or`, which the
 * planner would answer by hashing every owned artist in the library.
 */
export function artistOwned(alias: string): SQL {
  return sql.raw(`exists (
    select 1 from recording_artists ra join media_files f on f.recording_id = ra.recording_id and f.missing_since is null where ra.artist_id = ${alias}.id
    union all
    select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null where aa.artist_id = ${alias}.id)`)
}

/**
 * Run before `libraryQuery` in its transaction. The planner prices `word_similarity` too
 * low and would answer a fuzzy lookup that finds little by reading the whole table.
 */
export const seqScanOff = sql`select set_config('enable_seqscan', 'off', true)`

/** Condition: the album (alias) carries the genre, ignoring case. */
const albumHasGenre = (album: string, genre: string) =>
  sql`exists (select 1 from unnest(${sql.raw(album)}.genres) as g(name) where lower(g.name) = lower(${genre}))`

/**
 * Condition: the row `alias` of the kind belongs to the genre: an album that carries it, a
 * track on such an album (by its files or its releases), an artist credited on one. `true`
 * without a genre.
 */
function inGenre(kind: LibraryKind, alias: string, genre: string | undefined): SQL {
  if (!genre) return sql`true`
  const id = sql.raw(`${alias}.id`)
  if (kind === 'album') return albumHasGenre(alias, genre)
  if (kind === 'artist') return sql`exists (select 1 from album_artists ga_aa join albums ga on ga.id = ga_aa.album_id where ga_aa.artist_id = ${id} and ${albumHasGenre('ga', genre)})`
  return sql`(
    exists (select 1 from media_files gf join albums ga on ga.id = gf.album_id where gf.recording_id = ${id} and gf.missing_since is null and ${albumHasGenre('ga', genre)})
    or exists (select 1 from release_tracks grt join releases grl on grl.id = grt.release_id join albums ga on ga.id = grl.album_id
      where grt.recording_id = ${id} and ${albumHasGenre('ga', genre)}))`
}

/**
 * The query for one kind; exported for the performance test's EXPLAIN. With a genre, only
 * candidates of that genre are kept, before the page is cut, so `offset` pages within it
 * (the Library's search inside a genre chip).
 */
export function libraryQuery(kind: LibraryKind, userId: string, key: string, limit: number, offset = 0, genre?: string, scope: 'library' | 'server' = 'library', facets: SearchFacets = {}): SQL {
  const end = prefixEnd(key)
  // Apply facets inside each bounded lookup so unrelated hits cannot crowd out a page.
  const facet = hasSearchFacets(facets) ? sql`and ${searchFacetConditions(kind, kind === 'artist' ? 'a' : 't', userId, facets)}` : sql``
  const recent = sql`select recording_id, album_id from plays where user_id = ${userId} and not skipped order by started_at desc limit ${recentPlays}`

  // Also walk saves directly so numerous similar catalog rows cannot crowd them out.
  const similar = (column: string) => hasUnicode(key) ? fuzzy(key, sql.raw(column)) : key.length >= 3 ? sql`${key} <% ${sql.raw(column)}` : sql`false`
  if (kind === 'artist') {
    const credited = scope === 'server' ? artistOwned('a') : sql`exists (
      select 1 from album_artists aa where aa.artist_id = a.id and ${albumIsMember('aa.album_id', userId)})`
    const eligible = sql`a.merged_into_id is null and ${credited} ${facet}`
    return sql`
      with candidates as (
        (select a.id from artists a where a.name_key collate "C" >= ${key} and a.name_key collate "C" < ${end} and ${eligible} limit ${prefixCandidates})
        union
        (select a.id from likes own join artists a on a.id = own.entity_id
          where own.user_id = ${userId} and own.entity_type = 'artist' and a.merged_into_id is null ${facet}
            and (starts_with(a.name_key, ${key}) or ${similar('a.name_key')})
          limit ${prefixCandidates})
        union
        (select a.id from artists a where ${fuzzy(key, sql`a.name_key`)} and ${eligible} limit ${fuzzyCandidates})
      ),
      played as (
        select ra.artist_id as id, count(*)::int as plays from (${recent}) p join recording_artists ra on ra.recording_id = p.recording_id group by 1
      )
      select a.id from candidates c join artists a on a.id = c.id left join played on played.id = a.id
      where ${inGenre('artist', 'a', genre)}
      order by (a.name_key in (${key}, ${`the ${key}`}))::int * 2 + starts_with(a.name_key, ${key})::int desc,
        ${similarity(key, sql`a.name_key`)} desc, coalesce(played.plays, 0) desc,
        exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'artist' and l.entity_id = a.id) desc,
        a.name_key, a.id
      limit ${limit} offset ${offset}`
  }

  const table = sql.raw(kind === 'album' ? 'albums' : 'recordings')
  const likeType = kind === 'album' ? 'album' : 'recording'
  const member = kind === 'album' ? albumIsMember('t.id', userId) : recordingIsMember('t.id', userId)
  const present = kind === 'album'
    ? sql`exists (select 1 from media_files f where f.album_id = t.id and f.missing_since is null)`
    : recordingOwned('t.id')
  const eligible = sql`t.merged_into_id is null and ${scope === 'library' ? member : present} ${facet}`
  const playedBy = sql.raw(kind === 'album' ? 'album_id' : 'recording_id')
  const list = readings(key)
  const withAlbum = kind === 'track' && list.length > 1
  const albumContext = withAlbum ? sql`
    by_album as (
      select id, max(strength) as strength
      from k cross join lateral (
        select t.id, case when t.title_key = k.title then 2 else 1 end as strength
        from albums al cross join lateral (
          select rt.recording_id from releases re join release_tracks rt on rt.release_id = re.id where re.album_id = al.id
          union
          select f.recording_id from media_files f where f.album_id = al.id and f.missing_since is null and f.recording_id is not null
          union
          select h.id from recordings h where h.album_hint_id = al.id
        ) credited join recordings t on t.id = credited.recording_id
        where al.title_key collate "C" in (k.context, 'the ' || k.context) and al.merged_into_id is null
          and t.title_key collate "C" >= k.title and t.title_key collate "C" < k.title_end and ${eligible}
        limit ${prefixCandidates}
      ) matched group by id
    ),` : sql``
  return sql`
    with k as (${readingsTable(list)}),
    ${albumContext}
    candidates as (
      (select t.id from ${table} t
        where t.title_key collate "C" >= ${key} and t.title_key collate "C" < ${end} and ${eligible} limit ${prefixCandidates})
      union
      -- An "artist title" reading starts from the artist, which is far more selective than a title word.
      (select x.id from k cross join lateral (
        select t.id from artists ar join ${table} t on t.primary_artist_id = ar.id
        where k.context is not null and ar.name_key in (k.context, 'the ' || k.context) and ar.merged_into_id is null
          and starts_with(t.title_key, k.title) and ${eligible}
        limit ${prefixCandidates}) x)
      ${withAlbum ? sql`union select id from by_album` : sql``}
      union
      (select t.id from artists ar join ${table} t on t.primary_artist_id = ar.id
        where ar.name_key collate "C" >= ${key} and ar.name_key collate "C" < ${end} and ${eligible} limit ${fuzzyCandidates})
      union
      (select t.id from ${table} t where ${fuzzy(key, sql`t.match_key`)} and ${eligible} limit ${fuzzyCandidates})
      union
      (select t.id from likes own join ${table} t on t.id = own.entity_id
        where own.user_id = ${userId} and own.entity_type = ${likeType} and t.merged_into_id is null ${facet}
          and (starts_with(t.title_key, ${key}) or ${similar('t.match_key')}
            or exists (select 1 from artists ar where ar.id = t.primary_artist_id and starts_with(ar.name_key, ${key})))
        limit ${prefixCandidates})
    ),
    played as (select ${playedBy} as id, count(*)::int as plays from (${recent}) p group by 1)
    select t.id from candidates c join ${table} t on t.id = c.id left join played on played.id = t.id
    ${withAlbum ? sql`left join by_album on by_album.id = t.id` : sql``}
    where ${inGenre(kind, 't', genre)}
    order by greatest(
        ${withAlbum ? sql`by_album.strength,` : sql``}
        (select max(case
          when t.title_key in (k.title, 'the ' || k.title) and ${creditMatches('t')} then 2
          when starts_with(t.title_key, k.title) and ${creditMatches('t')} then 1
          else 0 end) from k),
        (select starts_with(ar.name_key, ${key})::int from artists ar where ar.id = t.primary_artist_id)) desc,
      ${similarity(key, sql`t.match_key`)} desc, coalesce(played.plays, 0) desc,
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = ${likeType} and l.entity_id = t.id) desc,
      t.title_key, t.id
    limit ${limit} offset ${offset}`
}

/**
 * Ids of the best artists, albums and tracks in scope for a `matchKey` query, at most `limit`
 * of each after skipping `offset`; only the `types` asked for (the others are empty), and
 * with a `genre` only what belongs to it (`inGenre`).
 */
export async function searchLibrary(userId: string, key: string, limit: number, page: { offset?: number; types?: readonly LibraryKind[]; genre?: string; scope?: 'library' | 'server'; facets?: SearchFacets } = {}):
  Promise<{ artists: string[]; albums: string[]; tracks: string[] }> {
  const offset = page.offset ?? 0
  const ids = async (kind: LibraryKind) => {
    if (page.types && !page.types.includes(kind)) return []
    return db.transaction(async (tx) => {
      await tx.execute(seqScanOff)
      return (await tx.execute<{ id: string }>(libraryQuery(kind, userId, key, limit, offset, page.genre, page.scope, page.facets))).map((row) => row.id)
    })
  }
  const [artists, albums, tracks] = await Promise.all([ids('artist'), ids('album'), ids('track')])
  return { artists, albums, tracks }
}
