import { ApiError, type ApiClient } from '@squirmy/client-core'
import { queryKeys, type AlbumSummary, type ArtistSummary, type LibrarySort, type Page, type SearchResults, type TrackSummary } from '@squirmy/contracts'
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type InfiniteQueryObserverResult } from '@tanstack/react-query'
import { awaitsTrackList } from '@/lib/catalog'
import { useApi } from './services'

/**
 * The queries the pages share. Keys start with `queryKeys`, so the server's invalidations
 * (likes, playlists, scans, plays) refresh whatever is on screen. Page queries are
 * `silent`: the page shows its own loading and error states.
 */

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404

/** Follows every cursor of a short list (playlists, wants) and returns all of it. */
async function everything<T>(load: (cursor: string | undefined) => Promise<Page<T>>): Promise<Page<T>> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await load(cursor)
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { items, nextCursor: null }
}

const silent = { silent: true }

/** Imports: their list, each one, and the upload options. `import.updated` refreshes them all. */
export const importsKey = ['imports'] as const

export const homeQuery = (api: ApiClient) => ({ queryKey: queryKeys.home(), queryFn: () => api.catalog.home(), meta: silent })

export function useHome() {
  return useQuery(homeQuery(useApi()))
}

export const albumQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.album(id), queryFn: () => api.catalog.album(id), meta: silent })
export const artistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.artist(id), queryFn: () => api.catalog.artist(id), meta: silent })
export const playlistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.playlist(id), queryFn: () => api.userdata.playlist(id), meta: silent })

/**
 * How often, and for how many answers, an album whose songs are still being looked up asks
 * again, should the server's invalidation not come: a minute, then the page waits for it.
 */
const TRACK_LIST_POLL_MS = 3000
const TRACK_LIST_POLLS = 20

export function useAlbum(id: string) {
  return useQuery({
    ...albumQuery(useApi(), id),
    refetchInterval: query => (query.state.data && awaitsTrackList(query.state.data) && query.state.dataUpdateCount < TRACK_LIST_POLLS ? TRACK_LIST_POLL_MS : false),
  })
}

export function useArtist(id: string) {
  return useQuery(artistQuery(useApi(), id))
}

export function usePlaylist(id: string) {
  return useQuery(playlistQuery(useApi(), id))
}

/** Your playlists and other people's public ones, recently changed first. */
export function usePlaylists() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.playlists(),
    queryFn: () => everything(cursor => api.userdata.playlists({ cursor, limit: 200 })),
    meta: silent,
  })
}

export function useWants(enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.wants(), queryFn: () => everything(cursor => api.userdata.wants({ cursor, limit: 200 })), enabled, meta: silent })
}

export function useGenres() {
  const api = useApi()
  return useQuery({
    queryKey: [...queryKeys.library(), 'genres'],
    queryFn: () => everything(cursor => api.catalog.genres({ cursor, limit: 200 })),
    meta: silent,
  })
}

export type LibraryKind = 'albums' | 'artists' | 'tracks'
export type LibraryFilter = { sort: LibrarySort; genre?: string }
type LibraryItems = { albums: AlbumSummary; artists: ArtistSummary; tracks: TrackSummary }

const libraryKeys = { albums: queryKeys.libraryAlbums, artists: queryKeys.libraryArtists, tracks: queryKeys.libraryTracks }
const pageSizes: Record<LibraryKind, number> = { albums: 60, artists: 60, tracks: 100 }

/** One of the library's lists, a page at a time as it scrolls. */
export const libraryListQuery = <K extends LibraryKind>(api: ApiClient, kind: K, filter: LibraryFilter) => {
  const fetchers = { albums: api.catalog.albums, artists: api.catalog.artists, tracks: api.catalog.tracks }
  return infiniteQueryOptions({
    queryKey: [...libraryKeys[kind](), filter],
    queryFn: ({ pageParam }) => fetchers[kind]({ ...filter, cursor: pageParam, limit: pageSizes[kind] }) as Promise<Page<LibraryItems[K]>>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    meta: silent,
  })
}

/** A new sort or genre keeps the current list on screen until its own first page arrives. */
export function useLibraryList<K extends LibraryKind>(kind: K, filter: LibraryFilter) {
  return useInfiniteQuery({ ...libraryListQuery(useApi(), kind, filter), placeholderData: keepPreviousData })
}

export function useLikedTracks() {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: [...queryKeys.likes(), 'track'],
    queryFn: ({ pageParam }) => api.userdata.likes('track', { cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    meta: silent,
  })
}

type PagedResult<T> = InfiniteQueryObserverResult<InfiniteData<Page<T>>>

export const itemsOf = <T>(data: InfiniteData<Page<T>> | undefined): T[] => data?.pages.flatMap(page => page.items) ?? []

/** The items of a paged list, loading the pages still missing until there are `limit`. */
export async function loadItems<T>(query: PagedResult<T>, limit: number): Promise<T[]> {
  let state = query
  while (state.hasNextPage && itemsOf(state.data).length < limit) {
    state = await state.fetchNextPage()
    if (state.isFetchNextPageError) break
  }
  return itemsOf(state.data).slice(0, limit)
}

/** A search route that is not there yet answers 404: no results, and a note that search is missing. */
const orMissing = (request: Promise<SearchResults>) => request.catch((error: unknown) => {
  if (isNotFound(error)) return null
  throw error
})

/** One search of the library or the catalog. The search page and the search dialog share its answers. */
export const searchQuery = (api: ApiClient, kind: 'library' | 'catalog', term: string) => ({
  queryKey: [...queryKeys.search(), kind, term],
  queryFn: ({ signal }: { signal: AbortSignal }) => orMissing(api.search[kind]({ q: term, limit: 20 }, { signal })),
  enabled: term.length > 0,
  staleTime: 60_000,
})

export function useUserSettings() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => api.userdata.settings(), meta: silent })
}

export function useScrobbling() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.scrobbling(), queryFn: () => api.scrobble.status(), meta: silent })
}
