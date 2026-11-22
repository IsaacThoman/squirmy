import type { AlbumSummary, ArtistSummary, SearchResults, SearchTopResult, TrackSummary } from '@squirmy/contracts'
import { albumPresentation, isPlayable, type Viewer } from './availability.js'

/** The result to lead with, carrying the item it names. */
export type SearchTop =
  | { type: 'artist'; artist: ArtistSummary }
  | { type: 'album'; album: AlbumSummary }
  | { type: 'track'; track: TrackSummary }

/** One result set for a query: the top result, then each kind in display order. */
export type MergedSearch = {
  top: SearchTop | null
  artists: ArtistSummary[]
  albums: AlbumSummary[]
  tracks: TrackSummary[]
}

type Answer = Pick<SearchResults, 'artists' | 'albums' | 'tracks' | 'top'>

/**
 * Merges `/search/library` and `/search/catalog` into one list per kind. Either may be null
 * while it loads. The library answer comes back first and ranks by the user's own plays, so
 * its rows lead in their order; catalog rows are appended after them, minus those already
 * listed, so rows on screen never move when the catalog answer lands. Within the appended
 * part, what this viewer cannot play goes last: search covers all music, but what plays
 * should come first.
 *
 * The top result is the better-scored of the two hints, the library's on a tie. Without
 * scores (an older server) the library's hint wins, else the catalog's. A hint that names
 * nothing in the lists is ignored.
 */
export function mergeSearch(library: Answer | null | undefined, catalog: Answer | null | undefined, viewer: Viewer | null | undefined): MergedSearch {
  const merged: MergedSearch = {
    top: null,
    artists: append(library?.artists, catalog?.artists, () => true),
    albums: append(library?.albums, catalog?.albums, album => albumPresentation(album, viewer) === 'normal'),
    tracks: append(library?.tracks, catalog?.tracks, track => isPlayable(track, viewer)),
  }
  const fromLibrary = find(merged, library?.top)
  const fromCatalog = find(merged, catalog?.top)
  const catalogWins = fromCatalog && (!fromLibrary || (catalog?.top?.score ?? 0) > (library?.top?.score ?? Infinity))
  merged.top = (catalogWins ? fromCatalog : fromLibrary) ?? null
  return merged
}

function append<T extends { id: string }>(first: readonly T[] | undefined, rest: readonly T[] | undefined, playable: (item: T) => boolean): T[] {
  const seen = new Set<string>()
  const keep = (item: T) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }
  const head = (first ?? []).filter(keep)
  const tail = (rest ?? []).filter(keep)
  return [...head, ...tail.filter(playable), ...tail.filter(item => !playable(item))]
}

function find(merged: MergedSearch, hint: SearchTopResult | null | undefined): SearchTop | null {
  if (!hint) return null
  if (hint.type === 'artist') {
    const artist = merged.artists.find(item => item.id === hint.id)
    return artist ? { type: 'artist', artist } : null
  }
  if (hint.type === 'album') {
    const album = merged.albums.find(item => item.id === hint.id)
    return album ? { type: 'album', album } : null
  }
  const track = merged.tracks.find(item => item.id === hint.id)
  return track ? { type: 'track', track } : null
}
