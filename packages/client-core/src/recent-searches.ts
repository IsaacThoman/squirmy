import { AlbumSummary, ArtistSummary, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { z } from 'zod'
import { searchItemKey } from './search.js'

/**
 * Results the viewer opened or played from Search, newest first. Kept on the device,
 * per server and user; each app stores the list where it keeps small preferences.
 */
const RecentSearch = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artist'), artist: ArtistSummary }),
  z.object({ type: z.literal('album'), album: AlbumSummary }),
  z.object({ type: z.literal('track'), track: TrackSummary }),
  z.object({ type: z.literal('playlist'), playlist: PlaylistSummary }),
])
export type RecentSearch = z.infer<typeof RecentSearch>

/** How many recently viewed results are kept. */
export const RECENT_SEARCH_LIMIT = 20

/** `entry` first, without an earlier copy of it, at most `RECENT_SEARCH_LIMIT` long. */
export function addRecentSearch(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const key = searchItemKey(entry)
  return [entry, ...list.filter(other => searchItemKey(other) !== key)].slice(0, RECENT_SEARCH_LIMIT)
}

export function removeRecentSearch(list: readonly RecentSearch[], key: string): RecentSearch[] {
  return list.filter(entry => searchItemKey(entry) !== key)
}

/**
 * Read the existing storage format, skipping legacy query strings and invalid results.
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
