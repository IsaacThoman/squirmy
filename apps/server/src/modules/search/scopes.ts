import type { LyricSearchResult, PlaylistSummary, SearchFacets } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordingOwned } from '../catalog/availability.js'
import { recordingIsMember } from '../catalog/library.js'
import { trackSummaries } from '../catalog/summaries.js'
import { playlistSummaries } from '../userdata/playlists.js'
import { searchFacetConditions } from './facets.js'
import { hasUnicode } from './keys.js'

export async function searchPlaylists(userId: string, key: string, limit: number, offset: number): Promise<PlaylistSummary[]> {
  // Each user's playlists are bounded; visibility is checked before scoring or paging.
  const similarity = hasUnicode(key)
    ? sql`search_unicode_score(search_unicode_bigrams(${key}), search_unicode_bigrams(name_key))`
    : sql`word_similarity(${key}, name_key)`
  const rows = await db.execute<{ id: string }>(sql`
    with visible as materialized (
      select id, search_name_key(name) as name_key
      from playlists where owner_id = ${userId} or is_public
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
