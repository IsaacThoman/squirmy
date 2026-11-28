import { ApiError, type ApiClient } from '@squirmy/client-core'
import { Id, queryKeys, type AlbumSummary, type ArtistSectionKey, type ArtistSummary, type LibraryItem, type LibraryItemsSort, type LibraryQuery, type Page, type SearchResults, type TrackSummary, type UploaderFilter } from '@squirmy/contracts'
import { infiniteQueryOptions, keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData, type InfiniteQueryObserverResult } from '@tanstack/react-query'
import { awaitsTrackList } from '@/lib/catalog'
import { useCallback, useRef } from 'react'
import { useDebounced } from '@/lib/use-debounced'
import { useApi } from './services'

/**
 * The queries the pages share. Keys start with `queryKeys`, so the server's invalidations
 * (likes, playlists, scans, plays) refresh whatever is on screen. Pages show their own
 * loading and error states.
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

/** Imports: their list, each one, and the upload options. `import.updated` refreshes them all. */
export const importsKey = ['imports'] as const

export const homeQuery = (api: ApiClient) => ({ queryKey: queryKeys.home(), queryFn: () => api.catalog.home() })

export function useHome() {
  return useQuery(homeQuery(useApi()))
}

export const albumQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.album(id), queryFn: () => byId(id, () => api.catalog.album(id)) })
export const artistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.artist(id), queryFn: () => byId(id, () => api.catalog.artist(id)) })
export const playlistQuery = (api: ApiClient, id: string) => ({ queryKey: queryKeys.playlist(id), queryFn: () => byId(id, () => api.userdata.playlist(id)) })

/**
 * How often, and for how long, an album whose songs are still being looked up asks again,
 * should the server's invalidation not come: a minute, then the page waits for it.
 */
const TRACK_LIST_POLL_MS = 3000
export const TRACK_LIST_POLL_FOR_MS = 60_000

/**
 * An album page's album. While its songs are being looked up it asks again every few seconds for
 * a minute from when the page opened. `refetch` (the page's "Check again") starts another minute:
 * counting answers instead would leave a person who asks again with a single answer, the polling
 * long since spent.
 */
export function useAlbum(id: string) {
  // When this page began waiting for this album's songs: set by the first answer that awaits them.
  const round = useRef<{ id: string; since: number } | null>(null)
  const query = useQuery({
    ...albumQuery(useApi(), id),
    refetchInterval: ({ state }) => {
      if (!state.data || !awaitsTrackList(state.data)) return false
      if (round.current?.id !== id) round.current = { id, since: Date.now() }
      return Date.now() - round.current.since < TRACK_LIST_POLL_FOR_MS ? TRACK_LIST_POLL_MS : false
    },
  })
  const { refetch } = query
  const checkAgain = useCallback<typeof refetch>(options => {
    round.current = { id, since: Date.now() }
    return refetch(options)
  }, [id, refetch])
  // Spread, the result loses the union that ties `data` to `status`; it is the same result with one function changed.
  return { ...query, refetch: checkAgain } as typeof query
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
  })
}

export function useWants(enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.wants(), queryFn: () => everything(cursor => api.userdata.wants({ cursor, limit: 200 })), enabled })
}

export function useGenres() {
  const api = useApi()
  return useQuery({
    queryKey: [...queryKeys.library(), 'genres'],
    queryFn: () => everything(cursor => api.catalog.genres({ cursor, limit: 200 })),
  })
}

/** `items` is the Library's All: albums, artists, playlists and Liked Songs in one list. */
export type LibraryKind = 'items' | 'albums' | 'artists' | 'tracks'
/** `played` is All's alone; the other lists are never asked for it. */
export type LibraryFilter = { sort: LibraryItemsSort; genre?: string }
type LibraryItems = { items: LibraryItem; albums: AlbumSummary; artists: ArtistSummary; tracks: TrackSummary }

const libraryKeys = { items: queryKeys.libraryItems, albums: queryKeys.libraryAlbums, artists: queryKeys.libraryArtists, tracks: queryKeys.libraryTracks }
const pageSizes: Record<LibraryKind, number> = { items: 60, albums: 60, artists: 60, tracks: 100 }

/** One of the library's lists, a page at a time as it scrolls. */
export const libraryListQuery = <K extends LibraryKind>(api: ApiClient, kind: K, filter: LibraryFilter) => {
  const list = (fetch: (query: Partial<LibraryQuery>) => Promise<Page<unknown>>) => ({ sort, ...query }: Omit<Partial<LibraryQuery>, 'sort'> & { sort: LibraryItemsSort }) =>
    fetch({ ...query, sort: sort === 'played' ? 'recent' : sort })
  const fetchers = { items: api.catalog.items, albums: list(api.catalog.albums), artists: list(api.catalog.artists), tracks: list(api.catalog.tracks) }
  return infiniteQueryOptions({
    queryKey: [...libraryKeys[kind](), filter],
    queryFn: ({ pageParam }) => fetchers[kind]({ ...filter, cursor: pageParam, limit: pageSizes[kind] }) as Promise<Page<LibraryItems[K]>>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
}

/**
 * A new sort or genre keeps the current list on screen until its own first page arrives. The
 * combined Library loads only the lists its filter shows (`enabled`).
 */
export function useLibraryList<K extends LibraryKind>(kind: K, filter: LibraryFilter, enabled = true) {
  return useInfiniteQuery({ ...libraryListQuery(useApi(), kind, filter), placeholderData: keepPreviousData, enabled })
}

/** The server's lists (`/collection/*`): its albums, their artists and its songs, whatever is in the user's library. */
export type CollectionKind = 'albums' | 'artists' | 'tracks'
const collectionKeys = { albums: queryKeys.collectionAlbums, artists: queryKeys.collectionArtists, tracks: queryKeys.collectionTracks }

/** One of the server's lists, a page at a time: the library's lists over all of the server's music (Home's See all). */
export function useCollectionList<K extends CollectionKind>(kind: K, filter: LibraryFilter, enabled = true) {
  const api = useApi()
  const fetchers = { albums: api.catalog.collectionAlbums, artists: api.catalog.collectionArtists, tracks: api.catalog.collectionTracks }
  const sort = filter.sort === 'played' ? 'recent' : filter.sort
  return useInfiniteQuery({
    queryKey: [...collectionKeys[kind](), filter],
    queryFn: ({ pageParam }) => fetchers[kind]({ ...filter, sort, cursor: pageParam, limit: pageSizes[kind] }) as Promise<Page<LibraryItems[K]>>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  })
}

/**
 * Whose uploads a page lists: the user's own (Your uploads), or for an admin everyone's,
 * one person's or the inbox's (`uploader`).
 */
export type UploadsScope = { admin: false } | { admin: true; uploader?: UploaderFilter }

const uploadsKey = (scope: UploadsScope) => (scope.admin ? [...queryKeys.adminUploads(), scope.uploader ?? null] : [...queryKeys.uploads()])

/** Uploads by album, newest first, a page at a time. */
export function useUploads(scope: UploadsScope) {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: uploadsKey(scope),
    queryFn: ({ pageParam }) => (scope.admin
      ? api.uploads.adminList({ cursor: pageParam, limit: 50, ...(scope.uploader && { uploader: scope.uploader }) })
      : api.uploads.list({ cursor: pageParam, limit: 50 })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  })
}

/** One album's uploaded songs, loaded when the album is opened on the page. */
export function useUploadFiles(scope: UploadsScope, albumId: string, uploader: UploaderFilter | undefined, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: [...uploadsKey(scope), 'album', albumId, uploader ?? null],
    queryFn: () => (scope.admin ? api.uploads.adminAlbum(albumId, uploader ? { uploader } : {}) : api.uploads.album(albumId)),
    enabled,
  })
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
  })
}

export type PagedResult<T> = InfiniteQueryObserverResult<InfiniteData<Page<T>>>

export const itemsOf = <T>(data: InfiniteData<Page<T>> | undefined): T[] => data?.pages.flatMap(page => page.items) ?? []

/** What `useNextPage` needs of an infinite query, whatever its pages hold. */
type PagedQuery = Pick<InfiniteQueryObserverResult, 'hasNextPage' | 'isPlaceholderData' | 'isFetchingNextPage' | 'isFetchNextPageError' | 'error'> & { fetchNextPage: () => Promise<unknown> }

/** A page past the first that failed, and a way to ask for it again. */
export type MoreFailure = { error: unknown; retrying: boolean; onRetry: () => void }

/**
 * Loads a paged list's next page as its end comes into view (`onEndReached`). A page that fails
 * stops the paging there, as the iOS app does, rather than asking for it again each time the end
 * is in view: the list says so at its end (`moreFailure`) with a way to try again. `paused` (while
 * a search stands in for the list) loads nothing.
 */
export function useNextPage(query: PagedQuery | undefined, paused = false) {
  // While another sort's list stands in, its cursor is not this list's.
  const hasNextPage = Boolean(query?.hasNextPage && !query.isPlaceholderData) && !paused
  const { fetchNextPage, isFetchingNextPage = false } = query ?? {}
  const failed = hasNextPage && Boolean(query?.isFetchNextPageError)
  const onEndReached = useCallback(() => {
    if (hasNextPage && !failed && !isFetchingNextPage) void fetchNextPage?.()
  }, [hasNextPage, failed, isFetchingNextPage, fetchNextPage])
  const moreFailure: MoreFailure | undefined = failed ? { error: query!.error, retrying: isFetchingNextPage, onRetry: () => void fetchNextPage?.() } : undefined
  return { hasNextPage, onEndReached, loadingMore: hasNextPage && isFetchingNextPage && !failed, moreFailure }
}

/**
 * The items of a paged list, loading the pages still missing until there are `limit`.
 * `complete` is false when a page failed to load: `items` are then the ones loaded so far.
 */
export async function loadItems<T>(query: PagedResult<T>, limit: number): Promise<{ items: T[]; complete: boolean }> {
  let state = query
  while (state.hasNextPage && itemsOf(state.data).length < limit) {
    state = await state.fetchNextPage()
    if (state.isFetchNextPageError) return { items: itemsOf(state.data).slice(0, limit), complete: false }
  }
  return { items: itemsOf(state.data).slice(0, limit), complete: true }
}

/** A search route that is not there yet answers 404: no results, and a note that search is missing. */
const orMissing = (request: Promise<SearchResults>) => request.catch((error: unknown) => {
  if (isNotFound(error)) return null
  throw error
})

/** One search of the library or the catalog. The search page and the search dialog share its answers. */
export const searchQuery = (api: ApiClient, kind: 'library' | 'catalog', term: string) => ({
  queryKey: [...queryKeys.search(), kind, term],
  queryFn: ({ signal }: { signal: AbortSignal }) => orMissing(api.search[kind]({ q: term, limit: 20, scope: 'server' }, { signal })),
  enabled: term.length > 0,
  staleTime: 60_000,
})

export function useUserSettings() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => api.userdata.settings() })
}

export function useScrobbling() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.scrobbling(), queryFn: () => api.scrobble.status() })
}
