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

type NoticeInput = {
  items: readonly unknown[] | null; stale: boolean; pending: boolean; failed: boolean; catalogFailed: boolean;
  moreFailed?: boolean; retryMore?: () => void;
};

/**
 * What the results say above their rows, as on web: offline with nothing on the phone that
 * matches (offline results otherwise show as they are); neither search answered; still
 * waiting; the catalog failed with nothing else found (`catalogEmpty`: not "No results", which
 * would say there is nothing to find); nothing found; or the catalog failed beside rows from
 * the server (`catalogNote`, not over an earlier search's rows). Null for just the rows.
 */
export function searchNotice(list: NoticeInput, offline: boolean):
  'offline' | 'failed' | 'searching' | 'catalogEmpty' | 'noResults' | 'catalogNote' | null {
  if (offline) return list.items?.length ? null : 'offline';
  if (list.failed) return 'failed';
  if (list.items === null) return 'searching';
  const empty = !list.items.length && !list.pending && !list.stale;
  if (empty) return list.catalogFailed ? 'catalogEmpty' : 'noResults';
  return list.catalogFailed && !list.stale ? 'catalogNote' : null;
}

/** What ends the results: the next page's failure with Try again, a spinner while more load, or nothing. */
export function searchEnd(list: NoticeInput): 'moreFailed' | 'loading' | null {
  if (list.moreFailed && !list.stale && !list.pending && list.retryMore) return 'moreFailed';
  return list.pending && list.items?.length ? 'loading' : null;
}
