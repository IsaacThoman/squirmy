import { mergeSearch, type SearchFilter, type SearchItem, type Viewer } from '@squirmy/client-core';
import type { PlaylistSummary, SearchResults } from '@squirmy/contracts';

/** The filters above the results, as the segmented control names them. */
export const searchFilterLabels: Record<SearchFilter, string> = { all: 'All', track: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' };

/**
 * How long the library's answer waits for the catalog's before it shows alone. The two
 * are ranked together, so a later catalog answer moves rows; most arrive within this,
 * and the last results stay on screen meanwhile.
 */
export const catalogWaitMs = 700;

/**
 * One ranked list for a search, from the library and catalog answers (either may still be
 * loading): client-core's `mergeSearch`, every kind mixed best first, with the viewer's
 * playlists whose name matches among them.
 */
export function searchItems(
  library: SearchResults | undefined, catalog: SearchResults | undefined, viewer: Viewer | null | undefined,
  query: string, playlists: readonly PlaylistSummary[] = [],
): SearchItem[] {
  return mergeSearch(library, catalog, viewer, { query, playlists: { query, items: playlists } }).items;
}

/**
 * What to show for the query typed: `full` once the catalog has answered (or failed),
 * `partial` once the library's answer has waited `catalogWaitMs` for it, else `wait`, which
 * keeps the last results on screen.
 */
export function searchStage({ library, catalog, catalogFailed, waited }: {
  library: boolean; catalog: boolean; catalogFailed: boolean; waited: boolean;
}): 'wait' | 'partial' | 'full' {
  if (catalog || (library && catalogFailed)) return 'full';
  return library && waited ? 'partial' : 'wait';
}
