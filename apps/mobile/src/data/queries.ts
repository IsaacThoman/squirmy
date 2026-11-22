import { ApiError } from '@squirmy/client-core';
import {
  queryKeys, type LibrarySort, type Lyrics, type Page, type SearchResults, type TrackSummary, type UpdateUserSettings,
  type UserSettings,
} from '@squirmy/contracts';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSignedInApi, type Api } from '../account/AccountProvider';
import { albumExpanding } from './albums';
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
function usePagedQuery<T>(queryKey: readonly unknown[], fetch: (api: Api, cursor: string | undefined) => Promise<Page<T>>) {
  const api = useSignedInApi();
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetch(api!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: Boolean(api),
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

export function useLibraryAlbums(sort: LibrarySort) {
  return usePagedQuery([...queryKeys.libraryAlbums(), sort], (api, cursor) => api.catalog.albums({ sort, cursor, limit: pageSize }));
}

export function useLibraryArtists(sort: LibrarySort) {
  return usePagedQuery([...queryKeys.libraryArtists(), sort], (api, cursor) => api.catalog.artists({ sort, cursor, limit: pageSize }));
}

export function useLibraryTracks(sort: LibrarySort) {
  const prime = usePrime();
  return usePagedQuery([...queryKeys.libraryTracks(), sort],
    async (api, cursor) => prime(await api.catalog.tracks({ sort, cursor, limit: pageSize }), page => page.items));
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

export function usePlaylists() {
  return usePagedQuery([...queryKeys.playlists(), 'list'], (api, cursor) => api.userdata.playlists({ cursor, limit: pageSize }));
}

export function useAlbum(id: string) {
  const prime = usePrime();
  const api = useSignedInApi();
  return useQuery({
    queryKey: queryKeys.album(id),
    queryFn: async () => prime(await api!.catalog.album(id), album => album.discs.flatMap(disc => disc.tracks)),
    enabled: Boolean(api),
    // An album the server has only heard of (from search or an artist's discography) comes
    // back without tracks while the server looks them up; the next answer has them.
    refetchInterval: query => albumExpanding(query.state.data, query.state.dataUpdateCount) ? 2000 : false,
  });
}

export function useArtist(id: string) {
  const prime = usePrime();
  return useApiQuery(queryKeys.artist(id), async api => prime(await api.catalog.artist(id), artist => artist.topTracks));
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
