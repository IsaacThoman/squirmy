import { AlbumSummary, ArtistSummary, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { z } from 'zod'
import type { SearchItem } from './search.js'

/**
 * What a search page offers before anything is typed: the queries the viewer searched
 * and the results they opened or played from a search, newest first. Kept on the device,
 * per server and user; each app stores the list where it keeps small preferences.
 */
export const RecentSearch = z.discriminatedUnion('type', [
  z.object({ type: z.literal('query'), query: z.string().min(1).max(200) }),
  z.object({ type: z.literal('artist'), artist: ArtistSummary }),
  z.object({ type: z.literal('album'), album: AlbumSummary }),
  z.object({ type: z.literal('track'), track: TrackSummary }),
  z.object({ type: z.literal('playlist'), playlist: PlaylistSummary }),
])
export type RecentSearch = z.infer<typeof RecentSearch>

/** How many recent searches are kept. */
export const RECENT_SEARCH_LIMIT = 20

export const recentSearchKey = (entry: RecentSearch): string => {
  switch (entry.type) {
    case 'query': return `query:${entry.query.trim().toLocaleLowerCase()}`
    case 'artist': return `artist:${entry.artist.id}`
    case 'album': return `album:${entry.album.id}`
    case 'track': return `track:${entry.track.id}`
    case 'playlist': return `playlist:${entry.playlist.id}`
  }
}

/** A result as the recent search it becomes once opened or played. */
export const recentFromItem = (item: SearchItem): RecentSearch => item

/** `entry` first, without an earlier copy of it, at most `RECENT_SEARCH_LIMIT` long. */
export function addRecentSearch(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  if (entry.type === 'query') {
    const query = entry.query.trim()
    if (!query) return [...list]
    entry = { type: 'query', query }
  }
  const key = recentSearchKey(entry)
  return [entry, ...list.filter(other => recentSearchKey(other) !== key)].slice(0, RECENT_SEARCH_LIMIT)
}

export function removeRecentSearch(list: readonly RecentSearch[], key: string): RecentSearch[] {
  return list.filter(entry => recentSearchKey(entry) !== key)
}

/**
 * The stored list, read back. What no longer parses (an entry saved by an older version
 * whose shape has changed, or anything that is not a list) is dropped rather than failing.
 */
export function parseRecentSearches(json: string | null | undefined): RecentSearch[] {
  if (!json) return []
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    const parsed = RecentSearch.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  }).slice(0, RECENT_SEARCH_LIMIT)
}

/** Where an app keeps the list for one account. */
export const recentSearchesStorageKey = (scope: string) => `squirmy.search.recent.${scope}`
