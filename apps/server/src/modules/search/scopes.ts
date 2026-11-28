import { playlistVisibleTo } from '../userdata/playlist-access.js'
import type { CreditSearchResult, LyricSearchResult, PlaylistSummary, SearchFacets, TrackCredit } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordingOwned } from '../catalog/availability.js'
import { recordingIsMember } from '../catalog/library.js'
import { trackSummaries } from '../catalog/summaries.js'
import { playlistSummaries } from '../userdata/playlists.js'
import { searchFacetConditions } from './facets.js'
import { searchIndexValidity } from './indexes.js'
import { hasUnicode, prefixEnd } from './keys.js'
import { fuzzyName, nameSimilarity } from './library.js'

export async function searchPlaylists(userId: string, key: string, limit: number, offset: number): Promise<PlaylistSummary[]> {
  // Each user's playlists are bounded; visibility is checked before scoring or paging.
  const similarity = hasUnicode(key)
    ? sql`search_unicode_score(search_unicode_bigrams(${key}), search_unicode_bigrams(name_key))`
    : sql`word_similarity(${key}, name_key)`
  const rows = await db.execute<{ id: string }>(sql`
    with visible as materialized (
      select id, search_name_key(name) as name_key
      from playlists p where ${playlistVisibleTo(userId)}
    )
    select id from visible
    where starts_with(name_key, ${key}) or strpos(' ' || name_key, ${` ${key}`}) > 0
      or (${[...key].length}::int >= 3 and ${similarity} >= 0.55)
    order by (name_key = ${key}) desc, starts_with(name_key, ${key}) desc, ${similarity} desc, name_key, id
    limit ${limit} offset ${offset}`)
  return playlistSummaries(rows.map(({ id }) => id), userId)
}

export async function searchLyrics(
  userId: string, query: string, limit: number, offset: number, scope: 'library' | 'server', facets: SearchFacets,
): Promise<LyricSearchResult[]> {
  if (!(await searchIndexValidity(['lyrics_search'])).get('lyrics_search')) return []
  const text = sql`search_lyric_text(l.plain, l.synced)`
  const document = sql`to_tsvector('simple', ${text})`
  const terms = sql`plainto_tsquery('simple', ${query})`
  const eligible = scope === 'server' ? recordingOwned('t.id') : recordingIsMember('t.id', userId)
  const rows = await db.execute<{ id: string; snippet: string }>(sql`
    select t.id, ts_headline('simple', ${text}, ${terms},
      'StartSel="", StopSel="", MaxWords=20, MinWords=8, MaxFragments=1') as snippet
    from lyrics l join recordings t on t.id = l.recording_id
    where not l.instrumental and t.merged_into_id is null and ${document} @@ ${terms} and ${eligible}
      and ${searchFacetConditions('track', 't', userId, facets)}
    order by ts_rank(${document}, ${terms}, 32) desc, t.id
    limit ${limit} offset ${offset}`)
  const tracks = await trackSummaries(userId, rows.map(({ id }) => ({ id })))
  const byId = new Map(tracks.map((track) => [track.id, track]))
  return rows.flatMap(({ id, snippet }) => {
    const track = byId.get(id)
    return track ? [{ track, snippet: snippet.replace(/\s+/gu, ' ').trim() }] : []
  })
}

export async function searchCredits(
  userId: string, key: string, limit: number, offset: number, scope: 'library' | 'server', facets: SearchFacets,
): Promise<CreditSearchResult[]> {
  const unicodeIndexed = !hasUnicode(key) || (await searchIndexValidity(['artists_name_key_unicode'])).get('artists_name_key_unicode')
  const fuzzy = unicodeIndexed ? fuzzyName(key, sql`a.name_key`) : sql`false`
  const similarity = nameSimilarity(key, sql`a.name_key`)
  const eligible = scope === 'server' ? recordingOwned('t.id') : recordingIsMember('t.id', userId)
  const rows = await db.execute<{ id: string; matched: TrackCredit[] }>(sql`
    with matched_artists as (
      select a.id, a.name, a.name_key from artists a
      where a.merged_into_id is null and (
        (a.name_key collate "C" >= ${key} and a.name_key collate "C" < ${prefixEnd(key)})
        or ${fuzzy})
      and exists (select 1 from recording_credits c where c.artist_id = a.id and c.role in ('composer', 'producer'))
    ), matches as (
      select coalesce(c.recording_id, f.recording_id) as recording_id,
        a.id as artist_id, a.name, c.role,
        (case when a.name_key = ${key} then 2 when starts_with(a.name_key, ${key}) then 1 else 0 end) + ${similarity} as score
      from matched_artists a join recording_credits c on c.artist_id = a.id and c.role in ('composer', 'producer')
      left join media_files f on f.id = c.file_id and f.missing_since is null
    ), distinct_credits as (
      select distinct recording_id, artist_id, name, role, score from matches
    )
    select t.id, jsonb_agg(jsonb_build_object('artist', jsonb_build_object('id', m.artist_id, 'name', m.name), 'role', m.role)
      order by m.score desc, m.name, m.role, m.artist_id) as matched
    from distinct_credits m join recordings t on t.id = m.recording_id
    where t.merged_into_id is null and ${eligible} and ${searchFacetConditions('track', 't', userId, facets)}
    group by t.id
    order by max(m.score) desc, t.title_key, t.id
    limit ${limit} offset ${offset}`)
  const tracks = await trackSummaries(userId, rows.map(({ id }) => ({ id })))
  const byId = new Map(tracks.map((track) => [track.id, track]))
  return rows.flatMap(({ id, matched }) => {
    const track = byId.get(id)
    return track ? [{ track, matched }] : []
  })
}
