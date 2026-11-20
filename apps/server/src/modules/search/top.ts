/**
 * `SearchResults.top`: the one result a client can lead with, so an album found by its
 * exact title is not shown below songs that only share a word with it.
 */
import type { SearchResults, SearchTopResult } from '@squirmy/contracts'
import { inArray } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordings } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'
import { editionFreeKey } from './keys.js'

type Found = Pick<SearchResults, 'artists' | 'albums' | 'tracks'>

/**
 * How exactly any of `names` matches the query key: 3 for the whole name, 2 once edition
 * suffixes are dropped, 1 when it starts with the query, 0 otherwise.
 */
function exactness(query: string, names: string[]): number {
  let best = 0
  for (const name of names) {
    const key = matchKey(name)
    if (key === query) return 3
    if (editionFreeKey(name) === query) best = Math.max(best, 2)
    else if (key.startsWith(query)) best = Math.max(best, 1)
  }
  return best
}

/** The title alone, and with its artist on either side ("radiohead ok computer"). */
const withArtist = (title: string, artist: string) => [title, `${artist} ${title}`, `${title} ${artist}`]

/**
 * Picks the result that matches the query best: by `exactness`, then by popularity (a
 * track's own, 0..1; an album's or artist's is the best of the returned tracks on it or
 * by them), then artist before album before track, then list order. Null when nothing
 * matches at least as a prefix.
 */
export async function topResult(query: string, found: Found): Promise<SearchTopResult | null> {
  const key = matchKey(query)
  const trackIds = found.tracks.map((track) => track.id)
  const rows = trackIds.length > 0
    ? await db.select({ id: recordings.id, popularity: recordings.popularity }).from(recordings).where(inArray(recordings.id, trackIds))
    : []
  const trackPopularity = new Map(rows.map((row) => [row.id, row.popularity ?? 0]))
  const best = (tracks: Found['tracks']) => Math.max(0, ...tracks.map((track) => trackPopularity.get(track.id) ?? 0))

  const candidates = [
    ...found.artists.map((artist) => ({
      type: 'artist' as const,
      id: artist.id,
      exactness: exactness(key, [artist.name]),
      popularity: best(found.tracks.filter((track) => track.artists.some((credit) => credit.id === artist.id))),
    })),
    ...found.albums.map((album) => ({
      type: 'album' as const,
      id: album.id,
      exactness: exactness(key, withArtist(album.title, album.artistCredit)),
      popularity: best(found.tracks.filter((track) => track.album?.id === album.id)),
    })),
    ...found.tracks.map((track) => ({
      type: 'track' as const,
      id: track.id,
      exactness: exactness(key, withArtist(track.title, track.artistCredit)),
      popularity: trackPopularity.get(track.id) ?? 0,
    })),
  ]
  let top: (typeof candidates)[number] | undefined
  // Candidates are in kind order, then list order, so a strict comparison keeps the earlier one on ties.
  for (const candidate of candidates) {
    if (candidate.exactness === 0) continue
    if (!top || candidate.exactness > top.exactness || (candidate.exactness === top.exactness && candidate.popularity > top.popularity)) top = candidate
  }
  return top ? { type: top.type, id: top.id } : null
}
