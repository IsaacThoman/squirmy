import { ApiError, type ApiClient } from '@squirmy/client-core'
import { Id, queryKeys, type AlbumSummary, type ArtistSectionKey, type ArtistSummary, type LibrarySort, type Page, type SearchResults, type TrackSummary } from '@squirmy/contracts'
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type InfiniteQueryObserverResult } from '@tanstack/react-query'
import { awaitsTrackList } from '@/lib/catalog'
import { useDebounced } from '@/lib/use-debounced'
import { useApi } from './services'

/**
 * The queries the pages share. Keys start with `queryKeys`, so the server's invalidations
 * (likes, playlists, scans, plays) refresh whatever is on screen. Page queries are
 * `silent`: the page shows its own loading and error states.
 */

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404

/**
 * A page id that cannot be one (a link cut short when pasted) names nothing, as an unknown id
 * does: it gets the same "Nothing here" without asking the server, which would refuse it as
 * an invalid request.
 */
function byId<T>(id: string, load: () => Promise<T>): Promise<T> {
  return Id.safeParse(id).success ? load() : Promise.reject(new ApiError(404, 'not_found', 'Nothing has this id.'))
}

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

export const albumQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.album(id), queryFn: () => byId(id, () => api.catalog.album(id)), meta: silent })
export const artistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.artist(id), queryFn: () => byId(id, () => api.catalog.artist(id)), meta: silent })
export const playlistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.playlist(id), queryFn: () => byId(id, () => api.userdata.playlist(id)), meta: silent })

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

/**
 * How often an artist whose discography is still coming in asks again, and for how many
 * answers. A large one takes minutes, so it keeps asking for ten; the server's invalidations
 * usually come sooner.
 */
const DISCOGRAPHY_POLL_MS = 5000
const DISCOGRAPHY_POLLS = 120

/** `poll: false` for a page that only borrows the artist (an album's "More by"): the invalidations are enough there. */
export function useArtist(id: string, { enabled = true, poll = true }: { enabled?: boolean; poll?: boolean } = {}) {
  return useQuery({
    ...artistQuery(useApi(), id),
    enabled,
    refetchInterval: query => (poll && query.state.data?.detailPending && query.state.dataUpdateCount < DISCOGRAPHY_POLLS ? DISCOGRAPHY_POLL_MS : false),
  })
}

/** One section of an artist page, a page at a time as it scrolls ("See all"). */
export function useArtistReleases(id: string, section: ArtistSectionKey, enabled = true) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: queryKeys.artistReleases(id, section),
    queryFn: ({ pageParam }) => byId(id, () => api.catalog.artistReleases(id, { section, cursor: pageParam, limit: 60 })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled,
    meta: silent,
  })
}

export function usePlaylist(id: string, enabled = true) {
  return useQuery({ ...playlistQuery(useApi(), id), enabled })
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

/**
 * A new sort or genre keeps the current list on screen until its own first page arrives. The
 * combined Library loads only the lists its filter shows (`enabled`).
 */
export function useLibraryList<K extends LibraryKind>(kind: K, filter: LibraryFilter, enabled = true) {
  return useInfiniteQuery({ ...libraryListQuery(useApi(), kind, filter), placeholderData: keepPreviousData, enabled })
}

/** The most matches the Library's own search lists; past it, the page asks for more letters. */
export const LIBRARY_MATCH_LIMIT = 50
/** The server's library search ignores shorter queries, so the Library filters what it has instead. */
export const LIBRARY_MATCH_MIN_LENGTH = 2

/** Whether `text` is long enough for the Library to search the whole library on the server. */
export const searchesServer = (text: string) => [...text.trim()].length >= LIBRARY_MATCH_MIN_LENGTH

/**
 * Albums, artists and songs in the library matching `text`, asked of the server once typing
 * pauses, best first, within `genre` when one is given. Under `LIBRARY_MATCH_MIN_LENGTH`
 * characters it asks nothing. `pending`: the answer for what is typed is still on its way.
 */
export function useLibraryMatches(text: string, genre?: string) {
  const api = useApi()
  const typed = text.trim()
  const q = useDebounced(typed, 150, '')
  const query = useQuery({
    queryKey: [...queryKeys.search(), 'library', q, LIBRARY_MATCH_LIMIT, genre ?? null],
    queryFn: ({ signal }) => api.search.library({ q, limit: LIBRARY_MATCH_LIMIT, ...(genre && { genre }) }, { signal }),
    enabled: searchesServer(q),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    meta: silent,
  })
  return { ...query, pending: typed !== q || query.isFetching }
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
