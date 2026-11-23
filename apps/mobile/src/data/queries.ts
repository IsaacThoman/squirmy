import { ApiError } from '@squirmy/client-core';
import {
  queryKeys, type ArtistSectionKey, type LibrarySort, type Lyrics, type Page, type SearchKind, type SearchResults, type TrackSummary, type UpdateUserSettings,
  type UserSettings,
} from '@squirmy/contracts';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSignedInApi, type Api } from '../account/AccountProvider';
import { albumPlaceholder, awaitsTrackList, findAlbumSummary, trackListPoll } from './albums';
import { artistPending, artistPlaceholder, findArtistSummary, pendingArtistPollMs } from './artists';
import { inLibraryOnly } from '../library/librarySearch';
import { useTrackStore } from './library';

const pageSize = 60;
const searchDelayMs = 250;
const emptyResults: SearchResults = { artists: [], albums: [], tracks: [], provider: null };

/** A query against the signed-in server. Disabled while signed out. */
function useApiQuery<T>(queryKey: readonly unknown[], fetch: (api: Api) => Promise<T>, options: { enabled?: boolean } = {}) {
  const api = useSignedInApi();
  return useQuery({ queryKey, queryFn: () => fetch(api!), enabled: Boolean(api) && options.enabled !== false });
}

/** A cursor-paginated list. `items` flattens the pages loaded so far. */
function usePagedQuery<T>(queryKey: readonly unknown[], fetch: (api: Api, cursor: string | undefined) => Promise<Page<T>>, enabled = true) {
  const api = useSignedInApi();
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetch(api!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: Boolean(api) && enabled,
  });
  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  return { ...query, items, loadMore: () => { if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage(); } };
}

/** Tracks a response carries are kept for queue rows and the lock screen, so they need no second request. */
function usePrime() {
  const tracks = useTrackStore();
  return <T>(value: T, list: (value: T) => readonly TrackSummary[]) => {
    tracks.prime(list(value));
    return value;
  };
}

export function useHome() {
  const prime = usePrime();
  return useApiQuery(queryKeys.home(), async api => prime(await api.catalog.home(),
    home => home.sections.flatMap(section => section.kind === 'tracks' ? section.tracks : [])));
}

export function useLibraryAlbums(sort: LibrarySort, enabled = true) {
  return usePagedQuery([...queryKeys.libraryAlbums(), sort], (api, cursor) => api.catalog.albums({ sort, cursor, limit: pageSize }), enabled);
}

export function useLibraryArtists(sort: LibrarySort, enabled = true) {
  return usePagedQuery([...queryKeys.libraryArtists(), sort], (api, cursor) => api.catalog.artists({ sort, cursor, limit: pageSize }), enabled);
}

export function useLibraryTracks(sort: LibrarySort, enabled = true) {
  const prime = usePrime();
  return usePagedQuery([...queryKeys.libraryTracks(), sort],
    async (api, cursor) => prime(await api.catalog.tracks({ sort, cursor, limit: pageSize }), page => page.items), enabled);
}

export function useLikedTracks() {
  const prime = usePrime();
  return usePagedQuery([...queryKeys.likes(), 'track'],
    async (api, cursor) => prime(await api.userdata.likes('track', { cursor, limit: pageSize }), page => page.items));
}

export function useHistory() {
  const prime = usePrime();
  return usePagedQuery(queryKeys.history(),
    async (api, cursor) => prime(await api.userdata.history({ cursor, limit: pageSize }), page => page.items.map(item => item.track)));
}

export function usePlaylists(enabled = true) {
  return usePagedQuery([...queryKeys.playlists(), 'list'], (api, cursor) => api.userdata.playlists({ cursor, limit: pageSize }), enabled);
}

export function useAlbum(id: string) {
  const prime = usePrime();
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  // Looked up once per page: the header can draw from the tile that opened it.
  const [placeholder] = useState(() => {
    const summary = findAlbumSummary(queryClient.getQueryCache().getAll().map(query => query.state.data), id);
    return summary && albumPlaceholder(summary);
  });
  // When this page began waiting for the album's songs; `checkAgain` starts a new wait.
  const waitingSince = useRef<number | null>(null);
  const query = useQuery({
    queryKey: queryKeys.album(id),
    queryFn: async () => prime(await api!.catalog.album(id), album => album.discs.flatMap(disc => disc.tracks)),
    enabled: Boolean(api),
    placeholderData: placeholder,
    // An album the server has only heard of (from search or an artist's discography) comes
    // back without tracks while the server looks them up; a later answer has them.
    refetchInterval: ({ state }) => {
      const awaiting = awaitsTrackList(state.data);
      if (awaiting) waitingSince.current ??= Date.now();
      return trackListPoll(Date.now() - (waitingSince.current ?? Date.now()), awaiting);
    },
  });
  const { refetch } = query;
  const checkAgain = useCallback(() => {
    waitingSince.current = Date.now();
    return refetch();
  }, [refetch]);
  return { query, checkAgain };
}

export function useArtist(id: string) {
  const prime = usePrime();
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  // As for albums: the header draws at once from the tile or row that opened the page.
  const [placeholder] = useState(() => {
    const summary = findArtistSummary(queryClient.getQueryCache().getAll().map(query => query.state.data), id);
    return summary && artistPlaceholder(summary);
  });
  return useQuery({
    queryKey: queryKeys.artist(id),
    queryFn: async () => prime(await api!.catalog.artist(id), artist => artist.topTracks),
    enabled: Boolean(api),
    placeholderData: placeholder,
    // A page answered while the server still fetches the profile and discography is not
    // final; the realtime invalidation that follows can be missed, so it is asked for again.
    refetchInterval: query => artistPending(query.state.data, query.state.dataUpdateCount) ? pendingArtistPollMs : false,
  });
}

export function usePlaylist(id: string) {
  const prime = usePrime();
  return useApiQuery(queryKeys.playlist(id), async api => prime(await api.userdata.playlist(id), playlist => playlist.items.map(item => item.track)));
}

/** Genres with the most albums first. */
export function useGenres() {
  return useApiQuery([...queryKeys.library(), 'genres'], async api => {
    const { items } = await api.catalog.genres({ limit: 200 });
    return [...items].sort((a, b) => b.albumCount - a.albumCount || a.name.localeCompare(b.name));
  });
}

/** One album of each genre, for its tile's cover and color. */
export function useGenreCovers(genres: readonly string[]) {
  const api = useSignedInApi();
  return useQueries({
    queries: genres.map(genre => ({
      queryKey: [...queryKeys.libraryAlbums(), 'genre', genre, 'cover'],
      queryFn: async () => (await api!.catalog.albums({ genre, limit: 1 })).items[0] ?? null,
      enabled: Boolean(api),
    })),
  }).map(result => result.data ?? undefined);
}

export function useGenreAlbums(genre: string) {
  return usePagedQuery([...queryKeys.libraryAlbums(), 'genre', genre],
    (api, cursor) => api.catalog.albums({ genre, cursor, limit: pageSize, sort: 'artist' }));
}

/**
 * Every release of one section of an artist page, paged, for its "See all". `enabled` is
 * false for a server without sections, whose page already lists them all.
 */
export function useArtistReleases(artistId: string, section: ArtistSectionKey, enabled: boolean) {
  return usePagedQuery(queryKeys.artistReleases(artistId, section),
    (api, cursor) => api.catalog.artistReleases(artistId, { section, cursor, limit: pageSize }), enabled);
}

/** Synced or plain lyrics, or null when the server has none for the track. */
export function useLyrics(track: TrackSummary | undefined) {
  return useApiQuery(queryKeys.lyrics(track?.id ?? ''), async (api): Promise<Lyrics | null> => {
    try {
      return await api.catalog.lyrics(track!.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, { enabled: Boolean(track?.hasLyrics) });
}

/** The value of `value` once it has stopped changing for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * The library and catalog searches for `text`, run in parallel once typing pauses. Each
 * keeps the previous answer on screen until the new one arrives. A server without the
 * search routes yet answers 404, which counts as no results.
 */
export function useSearch(text: string) {
  const q = useDebounced(text.trim(), searchDelayMs);
  const api = useSignedInApi();
  const prime = usePrime();
  const search = (scope: 'library' | 'catalog') => ({
    queryKey: [...queryKeys.search(), scope, q],
    queryFn: async () => {
      try {
        return prime(await api!.search[scope]({ q, limit: 20 }), results => results.tracks);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return emptyResults;
        throw error;
      }
    },
    enabled: Boolean(api && q),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const library = useQuery(search('library'));
  const catalog = useQuery(search('catalog'));
  return { query: q, library, catalog, pending: text.trim() !== q || library.isFetching || catalog.isFetching };
}

/** Rows per page of one kind of search result; the server answers at most 50. */
export const searchPageSize = 30;
/** The contract's largest offset. */
const lastSearchOffset = 450;

type SearchPage = { offset: number; library: SearchResults | null; catalog: SearchResults | null; catalogFailed: boolean };
const kindList = (answer: SearchResults | null, kind: SearchKind) =>
  (answer ? kind === 'artist' ? answer.artists : kind === 'album' ? answer.albums : answer.tracks : []);

/**
 * One kind of search result for a filter, page by page: each page is the library's and the
 * catalog's next `searchPageSize` of that kind, asked together once typing pauses.
 */
export function useSearchPages(text: string, kind: SearchKind | null) {
  const q = useDebounced(text.trim(), searchDelayMs);
  const api = useSignedInApi();
  const prime = usePrime();
  return useInfiniteQuery({
    queryKey: [...queryKeys.search(), 'pages', kind, q],
    enabled: Boolean(api && q && kind),
    initialPageParam: 0,
    queryFn: async ({ pageParam: offset }): Promise<SearchPage> => {
      const params = { q, limit: searchPageSize, type: kind!, offset };
      const [library, catalog] = await Promise.allSettled([api!.search.library(params), api!.search.catalog(params)]);
      if (library.status === 'rejected' && catalog.status === 'rejected') throw library.reason;
      const value = (result: PromiseSettledResult<SearchResults>) => (result.status === 'fulfilled' ? prime(result.value, answer => answer.tracks) : null);
      const missing = catalog.status === 'rejected' && catalog.reason instanceof ApiError && catalog.reason.status === 404;
      return { offset, library: value(library), catalog: value(catalog), catalogFailed: catalog.status === 'rejected' && !missing };
    },
    getNextPageParam: (last, pages) => {
      const full = [last.library, last.catalog].some(answer => kindList(answer, kind!).length >= searchPageSize);
      // An older server ignores `offset` and answers the first page again: nothing new, so the end.
      const earlier = new Set(pages.slice(0, -1).flatMap(page => [page.library, page.catalog].flatMap(answer => kindList(answer, kind!).map(item => item.id))));
      const fresh = [last.library, last.catalog].some(answer => kindList(answer, kind!).some(item => !earlier.has(item.id)));
      const next = last.offset + searchPageSize;
      return full && fresh && next <= lastSearchOffset ? next : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** The most matches the library filter shows of each kind; the server answers up to this many. */
export const libraryMatchLimit = 50;
/** The server's library search ignores queries shorter than this. */
export const libraryMatchMinLength = 2;

/**
 * Albums, artists and songs in the library matching `text`, searched on the server once
 * typing pauses, best matches first. Disabled below `libraryMatchMinLength` characters.
 */
export function useLibraryMatches(text: string) {
  const q = useDebounced(text.trim(), searchDelayMs);
  const api = useSignedInApi();
  const prime = usePrime();
  const query = useQuery({
    queryKey: [...queryKeys.search(), 'library', q, libraryMatchLimit],
    queryFn: async () => inLibraryOnly(prime(await api!.search.library({ q, limit: libraryMatchLimit }), results => results.tracks)),
    enabled: Boolean(api) && [...q].length >= libraryMatchMinLength,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  return { ...query, pending: text.trim() !== q || query.isFetching };
}

export function useUserSettings() {
  return useApiQuery(queryKeys.settings(), api => api.userdata.settings());
}

/** Saves settings, showing the change at once and rolling it back if the server refuses. */
export function useUpdateSettings() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: UpdateUserSettings) => api!.userdata.updateSettings(change),
    onMutate: async change => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings() });
      const previous = queryClient.getQueryData<UserSettings>(queryKeys.settings());
      if (previous) queryClient.setQueryData(queryKeys.settings(), { ...previous, ...change });
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.settings(), context.previous);
    },
    onSuccess: settings => queryClient.setQueryData(queryKeys.settings(), settings),
  });
}

export function useScrobbling() {
  return useApiQuery(queryKeys.scrobbling(), api => api.scrobble.status());
}
