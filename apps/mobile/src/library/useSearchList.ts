import { ApiError, mergeSearch, continuesQuery, filterKind, keepOrder, playlistScore, searchItemKey, type SearchFilter, type SearchItem } from '@squirmy/client-core';
import {
  addRecentSearch, parseRecentSearches, recentSearchesStorageKey, type RecentSearch,
} from '@squirmy/client-core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAccountKey } from '../account/AccountProvider';
import { useAllPlaylists, useSearch, useSearchPages } from '../data/queries';
import { useViewer } from '../downloads/DownloadsProvider';
import { catalogWaitMs, searchItems, searchStage } from './search';

/** The results for what is typed and the filter chosen, however they were found. */
export type SearchList = {
  /** Null until an answer that may be shown has arrived. */
  items: SearchItem[] | null;
  /** The items answer an earlier query or filter and stay while the new answer loads. */
  stale: boolean;
  /** More results for what is typed are on their way (the catalog's, or the next page). */
  pending: boolean;
  failed: boolean;
  /** The catalog could not be searched; what is listed is the server's own music. */
  catalogFailed: boolean;
  /** A failed search is being asked again (Try again): its failure stays shown until the answer. */
  retrying?: boolean;
  refetch: () => Promise<unknown>;
  loadMore?: () => void;
  /**
   * The next page did not load. The list ends with the failure and Try again (`retryMore`)
   * instead of asking again each time its end comes into view.
   */
  moreFailed?: boolean;
  retryMore?: () => void;
};

/**
 * The Search tab's list. All mixes every kind as the server ranks them: it waits for the
 * catalog's answer, or `catalogWaitMs` after the library's, keeping the last results on
 * screen meanwhile, so rows do not reshuffle with every key. A kind pages further as the
 * list ends. Older servers fall back to matching the device’s loaded playlists.
 */
export function useSearchList(text: string, filter: SearchFilter): SearchList {
  const viewer = useViewer();
  const term = text.trim();
  const search = useSearch(filter === 'all' ? text : '');
  const pages = useSearchPages(text, filterKind(filter));
  const answered = search.query === term && term.length > 0;
  const library = answered && !search.library.isPlaceholderData ? search.library.data : undefined;
  const playlistPage = !pages.isPlaceholderData && pages.data?.pages[0];
  const legacyPlaylistPage = filter === 'playlist' && (playlistPage
    ? playlistPage.library?.playlists === undefined
    : pages.error instanceof ApiError && (pages.error.status === 400 || pages.error.status === 404));
  const playlists = useAllPlaylists(Boolean(legacyPlaylistPage || (filter === 'all' && library && library.playlists === undefined)));
  const playlistItems = useMemo(() => playlists.data?.pages.flatMap(page => page.items) ?? [], [playlists.data]);
  const catalog = answered && !search.catalog.isPlaceholderData ? search.catalog.data : undefined;
  // A query is in error while fetching only when it is asked again after failing (Try again):
  // the failure stays shown meanwhile, so the list does not jump in between.
  const catalogFailed = answered && search.catalog.isError;
  const catalogRetrying = catalogFailed && search.catalog.isFetching;
  const libraryFailed = answered && search.library.isError && !search.library.isFetching;

  const [waited, setWaited] = useState<string | null>(null);
  useEffect(() => {
    if (!library || catalog) return;
    const timer = setTimeout(() => setWaited(term), catalogWaitMs);
    return () => clearTimeout(timer);
  }, [library, catalog, term]);
  const stage = searchStage({ library: library !== undefined || libraryFailed, catalog: catalog !== undefined, catalogFailed, waited: waited === term });

  // The order rows were shown in for this query once both answers were in, so a refreshed answer does not move them.
  const shownOrder = useRef<{ term: string; order: string[] } | null>(null);
  const all = useMemo(() => {
    if (stage === 'wait') return null;
    const items = searchItems(library, catalog, viewer, term, playlistItems);
    if (stage !== 'full') return { term, items, full: false };
    const kept = keepOrder(items, shownOrder.current?.term === term ? shownOrder.current.order : null);
    shownOrder.current = { term, order: kept.order };
    return { term, items: kept.items, full: true };
  }, [stage, library, catalog, viewer, term, playlistItems]);

  const paged = useMemo(() => {
    const kind = filterKind(filter);
    if (!kind || !pages.data) return null;
    const seen = new Set<string>();
    const items: SearchItem[] = [];
    for (const page of pages.data.pages) {
      const merged = mergeSearch(page.library, page.catalog, viewer, { query: term });
      const rows: SearchItem[] = kind === 'lyrics' ? merged.lyricItems : merged.items;
      for (const item of rows) {
        // An older server ignores `type` and answers every kind.
        if ((kind === 'lyrics' || item.type === kind) && !seen.has(searchItemKey(item))) {
          seen.add(searchItemKey(item));
          items.push(item);
        }
      }
    }
    return items;
  }, [filter, pages.data, viewer, term]);

  const current = useMemo((): SearchList | null => {
    if (!term) return null;
    if (legacyPlaylistPage) {
      const items = playlistItems.map(playlist => ({ playlist, score: playlistScore(term, playlist.name) }))
        .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
        .map(({ playlist }): SearchItem => ({ type: 'playlist', playlist }));
      if (playlists.isError && !playlists.data) return { items: null, stale: false, pending: false, failed: true, catalogFailed: false, refetch: playlists.refetch };
      // Found among the playlists loaded so far, with more on their way until the list is whole.
      const pending = !playlists.complete && !playlists.isFetchNextPageError;
      return { items, stale: false, pending, failed: false, catalogFailed: false, refetch: playlists.refetch };
    }
    if (filter === 'all') {
      if (libraryFailed && (catalogFailed || search.catalog.isError)) {
        return { items: null, stale: false, pending: false, failed: true, catalogFailed: false, refetch: () => Promise.all([search.library.refetch(), search.catalog.refetch()]) };
      }
      if (!all) return null;
      return {
        items: all.items, stale: false, pending: !all.full, failed: false, catalogFailed, retrying: catalogRetrying,
        refetch: () => Promise.all([search.library.refetch(), search.catalog.refetch()]),
      };
    }
    if (pages.isError && !pages.data) return { items: null, stale: false, pending: false, failed: true, catalogFailed: false, refetch: pages.refetch };
    if (!paged || pages.isPlaceholderData) return null;
    const moreFailed = pages.isFetchNextPageError;
    return {
      items: paged, stale: false, pending: pages.isFetchingNextPage, failed: false,
      catalogFailed: pages.data?.pages.some(page => page.catalogFailed) ?? false, refetch: pages.refetch,
      retrying: pages.isRefetching && !pages.isFetchingNextPage,
      // A page that failed is asked for again only from its Try again, not as the list's end comes into view.
      loadMore: pages.hasNextPage && !pages.isFetchingNextPage && !moreFailed ? () => void pages.fetchNextPage() : undefined,
      moreFailed, retryMore: () => void pages.fetchNextPage(),
    };
  }, [term, filter, all, paged, pages, legacyPlaylistPage, playlists, playlistItems, search.library, search.catalog, libraryFailed, catalogFailed, catalogRetrying]);

  // The last results shown stand in, faded, while the next ones are on their way: only for the
  // same filter and the same search typed on or deleted back, never under an unrelated one.
  // Kept by what it lists, not by identity: the query results it is built from are new objects
  // on most renders, and storing each would render again without end.
  const [shown, setShown] = useState<{ term: string; filter: SearchFilter; signature: string; list: SearchList } | null>(null);
  const signature = current?.items ? `${term}\n${filter}\n${current.items.map(searchItemKey).join(',')}` : null;
  if (current && signature !== null && signature !== shown?.signature) setShown({ term, filter, signature, list: current });
  if (!term) return { items: null, stale: false, pending: false, failed: false, catalogFailed: false, refetch: async () => {} };
  if (current) return current;
  return shown?.list.items && shown.filter === filter && continuesQuery(term, shown.term)
    ? { ...shown.list, stale: true, pending: true, loadMore: undefined, moreFailed: false }
    : { items: null, stale: false, pending: true, failed: false, catalogFailed: false, refetch: async () => {} };
}

/** A listener per subscriber, told when this device's recently viewed results change. */
const listeners = new Set<() => void>();
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;

/**
 * Results opened or played from Search, kept on this device per server and
 * account (the app's local storage), newest first.
 */
export function useRecentSearches() {
  const account = useAccountKey();
  const key = account ? recentSearchesStorageKey(account) : null;
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const json = useSyncExternalStore(subscribe, () => (key ? storage()?.getItem(key) ?? null : null));
  const list = useMemo(() => parseRecentSearches(json), [json]);
  const write = useCallback((next: (list: RecentSearch[]) => RecentSearch[] | null) => {
    if (!key) return;
    const value = next(parseRecentSearches(storage()?.getItem(key)));
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
    for (const listener of listeners) listener();
  }, [key]);
  return {
    list,
    add: useCallback((entry: RecentSearch) => write(current => addRecentSearch(current, entry)), [write]),
    clear: useCallback(() => write(() => null), [write]),
  };
}
