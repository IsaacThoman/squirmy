/**
 * Route containers for the music pages. Each one gathers its data with TanStack Query and
 * hands it to a view in components/views.
 */
import { filterKind, searchContext, searchFilters, searchQueue, type SearchFilter, type SearchItem } from '@squirmy/client-core'
import type { HomeSection, Page as ListPage, PlaylistDetail, TrackSummary } from '@squirmy/contracts'
import { queryKeys } from '@squirmy/contracts'
import { useMutation, useQueryClient, type InfiniteData, type UseQueryResult } from '@tanstack/react-query'
import { Compass } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { moveItem } from '@/lib/reorder'
import { useCachedSummary } from '@/api/prefetch'
import {
  isNotFound, itemsOf, LIBRARY_MATCH_LIMIT, loadItems, searchesServer, useAlbum, useArtist, useArtistReleases, useGenres, useHome, useLibraryList, useLibraryMatches,
  useLikedTracks, usePlaylist, usePlaylists, useWants,
} from '@/api/queries'
import { useApi } from '@/api/services'
import { matchingPlaylists, useMergedSearch, useSearchPages } from '@/api/use-search'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { Page } from '@/components/layout/Page'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { CollectionSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { LoadError, QueryState } from '@/components/ui/query-state'
import { AlbumView } from '@/components/views/AlbumView'
import { ArtistReleasesView, ArtistView } from '@/components/views/ArtistView'
import { HomeView, type ScanProgress } from '@/components/views/HomeView'
import { LibraryView, type LibraryItem } from '@/components/views/LibraryView'
import {
  isLibraryFilter, isLibrarySort, matches, readLibraryFilter, readLibraryLayout, sortFor, sortsFor, writeLibraryFilter, writeLibraryLayout,
  type LibraryFilterName,
} from '@/components/views/library-state'
import { LikedView, PlaylistView } from '@/components/views/PlaylistView'
import { AlbumPreview, ArtistPreview } from '@/components/views/Previews'
import { SearchView, type SearchList } from '@/components/views/SearchView'
import { WantlistView } from '@/components/views/WantlistView'
import { canFetch, isArtistSectionKey, isPlayable } from '@/lib/catalog'
import { usePageTitle } from '@/lib/document-title'
import { plural } from '@/lib/format'
import { useRecentSearches } from '@/lib/recent-searches'
import { useUrlDraft } from '@/lib/use-url-draft'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls, type PlayOptions } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'
import { useServerEvent } from '@/realtime/realtime-context'

export function NotFoundPage() {
  usePageTitle('Nothing here')
  return (
    <Page>
      <EmptyState icon={<Compass />} title="Nothing here" description="This page does not exist, or the music it pointed to is gone." headingLevel={1} action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>} />
    </Page>
  )
}

function ErrorPage({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying?: boolean }) {
  usePageTitle('Page did not load')
  return (
    <Page>
      <LoadError variant="page" title="This page did not load" error={error} onRetry={onRetry} retrying={retrying} />
    </Page>
  )
}

/** A page's main query: its skeleton while loading, "Nothing here" for a 404, a retry for other failures. */
function Loaded<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton: ReactNode; children: (data: T) => ReactNode }) {
  return (
    <QueryState
      query={query}
      loading={skeleton}
      errorTitle="This page did not load"
      variant="page"
      renderError={error => (isNotFound(error) ? <NotFoundPage /> : <ErrorPage error={error} retrying={query.isFetching} onRetry={() => void query.refetch()} />)}
    >
      {children}
    </QueryState>
  )
}

/** Files read so far by the scans running now, from the server's progress events. */
function useScanProgress(): ScanProgress | null {
  const [roots, setRoots] = useState<Record<string, ScanProgress>>({})
  useServerEvent('scan.progress', event => setRoots(current => {
    const { [event.rootId]: _, ...rest } = current
    return event.phase === 'idle' ? rest : { ...rest, [event.rootId]: { processed: event.processed, total: event.total } }
  }))
  const scans = Object.values(roots)
  return scans.length ? { processed: scans.reduce((sum, scan) => sum + scan.processed, 0), total: scans.reduce((sum, scan) => sum + scan.total, 0) } : null
}

export function HomePage() {
  const { playAlbum, playPlaylist } = usePlayCollections()
  const user = useCurrentUser()
  const home = useHome()
  const scan = useScanProgress()
  // A failed refetch keeps the last answer on screen; only a first answer that failed replaces the page.
  if (home.error && !home.data) return <ErrorPage error={home.error} retrying={home.isFetching} onRetry={() => void home.refetch()} />
  const { featured, sections } = featuring(home.data?.sections)
  return (
    <HomeView
      featured={featured}
      sections={sections}
      empty={Boolean(home.data) && home.data!.sections.every(isEmptySection)}
      canAddMusic={user.role === 'admin'}
      canFindMusic={canFetch(user)}
      scan={scan}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
    />
  )
}

/**
 * The album Home leads with: the one played last, else the one added last. It leaves the rail it
 * came from, which would otherwise start with it again, and the sections keep the server's order.
 */
function featuring(sections: HomeSection[] | undefined) {
  const source = ['recently-played', 'recently-added']
    .map(id => sections?.find(section => section.id === id))
    .find((section): section is Extract<HomeSection, { kind: 'albums' }> => section?.kind === 'albums' && section.albums.length > 0)
  const album = source?.albums[0]
  return {
    featured: album ? { album, label: source!.id === 'recently-played' ? 'Jump back in' : 'Recently added' } as const : null,
    sections: sections?.map(section => (section === source ? { ...section, albums: section.albums.slice(1) } : section)),
  }
}

const isEmptySection = (section: HomeSection) => (
  section.kind === 'albums' ? !section.albums.length
    : section.kind === 'artists' ? !section.artists.length
      : section.kind === 'playlists' ? !section.playlists.length
        : !section.tracks.length
)

export function AlbumPage() {
  const { playAlbum } = usePlayCollections()
  const id = useParams().id ?? ''
  const query = useAlbum(id)
  const summary = useCachedSummary('album', id, query.data === undefined)
  // The lead artist's discography, for other versions and "More by" under the songs; asked once the album is here.
  const leadId = query.data?.artists[0]?.id
  const artist = useArtist(leadId ?? '', { enabled: Boolean(leadId), poll: false }).data
  return (
    <Loaded query={query} skeleton={summary ? <AlbumPreview album={summary} /> : <CollectionSkeleton />}>
      {album => (
        <AlbumView
          key={album.id}
          album={album}
          artist={artist}
          onPlayAlbum={other => void playAlbum(other)}
          onRefresh={() => query.refetch()}
        />
      )}
    </Loaded>
  )
}

export function ArtistPage() {
  const { playAlbum } = usePlayCollections()
  const id = useParams().id ?? ''
  const query = useArtist(id)
  const summary = useCachedSummary('artist', id, query.data === undefined)
  return (
    <Loaded query={query} skeleton={summary ? <ArtistPreview artist={summary} /> : <CollectionSkeleton round />}>
      {artist => <ArtistView key={artist.id} artist={artist} onPlayAlbum={album => void playAlbum(album)} />}
    </Loaded>
  )
}

/** "See all" of one section of an artist page: `/artist/:id/releases/:section`. */
export function ArtistReleasesPage() {
  const { playAlbum } = usePlayCollections()
  const { id = '', section = '' } = useParams()
  const known = isArtistSectionKey(section)
  const artist = useArtist(id)
  const summary = useCachedSummary('artist', id, artist.data === undefined)
  const releases = useArtistReleases(id, known ? section : 'album', known)
  if (!known || isNotFound(artist.error) || isNotFound(releases.error)) return <NotFoundPage />
  if (releases.error && !releases.data) return <ErrorPage error={releases.error} retrying={releases.isFetching} onRetry={() => void releases.refetch()} />
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = releases
  return (
    <ArtistReleasesView
      key={`${id}/${section}`}
      artist={artist.data ?? summary}
      artistId={id}
      section={section}
      total={artist.data?.sections?.find(candidate => candidate.key === section)?.total}
      albums={releases.data && itemsOf(releases.data)}
      onEndReached={() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage() }}
      onPlayAlbum={album => void playAlbum(album)}
    />
  )
}

export function PlaylistPage() {
  const id = useParams().id ?? ''
  // The playlist being deleted is not asked for again: the server's invalidation of the
  // playlists also refreshes this one, which would answer 404 while the page is still open.
  const [deleting, setDeleting] = useState<string | null>(null)
  const query = usePlaylist(id, deleting !== id)
  return (
    <Loaded query={query} skeleton={<CollectionSkeleton />}>
      {playlist => <EditablePlaylist key={playlist.id} playlist={playlist} onDeleting={on => setDeleting(on ? playlist.id : null)} />}
    </Loaded>
  )
}

function EditablePlaylist({ playlist, onDeleting }: { playlist: PlaylistDetail; onDeleting: (deleting: boolean) => void }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  const key = queryKeys.playlist(playlist.id)
  const save = (detail: PlaylistDetail) => queryClient.setQueryData(key, detail)
  const refetch = () => queryClient.invalidateQueries({ queryKey: key })
  const change = (edit: (detail: PlaylistDetail) => PlaylistDetail) => queryClient.setQueryData<PlaylistDetail>(key, detail => detail && edit(detail))

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.userdata.updatePlaylist>[1]) => api.userdata.updatePlaylist(playlist.id, patch),
    onSuccess: summary => {
      queryClient.setQueryData<PlaylistDetail>(key, detail => detail && { ...detail, ...summary })
      return queryClient.invalidateQueries({ queryKey: queryKeys.playlists(), exact: true })
    },
    meta: { inline: true },
  })
  const deleted = useRef(false)
  const remove = useMutation({
    mutationFn: () => api.userdata.deletePlaylist(playlist.id),
    onMutate: () => onDeleting(true),
    onError: () => onDeleting(false),
    onSuccess: () => {
      deleted.current = true
      toast({ title: 'Playlist deleted', description: playlist.name })
      void navigate('/library?filter=playlists', { replace: true })
      return queryClient.invalidateQueries({ queryKey: queryKeys.playlists(), exact: true })
    },
  })
  // Dropped from the cache once the page has gone: removed while it shows, the page would ask for it again.
  useEffect(() => () => {
    if (deleted.current) queryClient.removeQueries({ queryKey: queryKeys.playlist(playlist.id), exact: true })
  }, [queryClient, playlist.id])
  // Moves and removals show at once; the server's answer, or a refetch after a failure, replaces them.
  const move = useMutation({
    mutationFn: ({ itemId, toIndex }: { itemId: string; toIndex: number }) => api.userdata.movePlaylistItem(playlist.id, { itemId, toIndex }),
    onSuccess: save,
    onError: refetch,
  })
  const drop = useMutation({
    mutationFn: (itemId: string) => api.userdata.removePlaylistItem(playlist.id, itemId),
    onSuccess: save,
    onError: refetch,
  })

  return (
    <>
      <PlaylistView
        playlist={playlist}
        owned={playlist.ownerId === user.id}
        onEdit={() => setDialog('edit')}
        onTogglePublic={() => update.mutate({ isPublic: !playlist.isPublic })}
        onDelete={() => setDialog('delete')}
        onMove={(from, to) => {
          if (to < 0 || to >= playlist.items.length || from === to) return
          change(detail => ({ ...detail, items: moveItem(detail.items, from, to) }))
          move.mutate({ itemId: playlist.items[from].itemId, toIndex: to })
        }}
        onRemove={index => {
          const { itemId, track } = playlist.items[index]
          change(detail => ({ ...detail, items: detail.items.filter(item => item.itemId !== itemId) }))
          drop.mutate(itemId)
          toast({ title: 'Removed from playlist', description: track.title })
        }}
      />
      <PlaylistDialog open={dialog === 'edit'} onOpenChange={open => setDialog(open ? 'edit' : null)} playlist={playlist} onSubmit={request => update.mutateAsync(request)} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={open => setDialog(open ? 'delete' : null)}
        title={`Delete “${playlist.name}”?`}
        description={`${playlist.isPublic ? 'It is public, so it goes away for everyone who can see it. ' : ''}This can’t be undone. No songs are removed from your library or your other playlists.`}
        confirmLabel="Delete"
        onConfirm={() => remove.mutateAsync()}
      />
    </>
  )
}

export function LikedPage() {
  const liked = useLikedTracks()
  const controls = usePlayerControls()
  const context = { type: 'liked', id: null, title: 'Liked Songs' } as const
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = liked
  const play = async (index: number, options?: PlayOptions) => controls.playTracks(await loadItems(liked, 5000), index, context, options)
  return (
    <Loaded query={liked} skeleton={<CollectionSkeleton />}>
      {data => (
        <LikedView
          tracks={itemsOf(data)}
          complete={!hasNextPage}
          onEndReached={() => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage() }}
          onPlay={(index, options) => void play(index, options)}
        />
      )}
    </Loaded>
  )
}

export function WantlistPage() {
  const enabled = useWantlistEnabled()
  const wants = useWants(enabled).data?.items
  if (!enabled) return <Navigate to="/" replace />
  return (
    <WantlistView
      albums={wants?.flatMap(item => (item.type === 'album' ? [item.album] : []))}
      tracks={wants?.flatMap(item => (item.type === 'track' ? [item.track] : []))}
    />
  )
}

const filterOf = (value: string | null): SearchFilter => (searchFilters as readonly string[]).includes(value ?? '') ? value as SearchFilter : 'all'

/**
 * `/search?q=…&type=…`: what is typed and the filter live in the URL, so Back returns to the
 * same results (the answers are cached) at the same place (the shell restores the scroll).
 */
export function SearchPage() {
  const navigate = useNavigate()
  const user = useCurrentUser()
  const library = useLibrary()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const [params, setParams] = useSearchParams()
  const genres = useGenres().data?.items.map(genre => genre.name) ?? []
  const query = params.get('q') ?? ''
  const filter = filterOf(params.get('type'))
  const [typed, setTyped] = useUrlDraft(query)
  const term = typed.trim()
  const all = useMergedSearch(typed, { playlists: library.playlists })
  const pages = useSearchPages(typed, filterKind(filter))
  const recents = useRecentSearches(user.id)
  const show = (q: string, next: SearchFilter) => setParams({ ...(q ? { q } : {}), ...(next !== 'all' ? { type: next } : {}) }, { replace: true })

  const list = useMemo<SearchList>(() => {
    const allItems = all.results?.items ?? null
    if (filter === 'all') {
      return {
        items: allItems, stale: all.stale, pending: Boolean(allItems) && !all.stale && all.catalogPending,
        failed: all.failed, catalogFailed: all.catalogFailed, unavailable: all.unavailable, retry: all.retry,
      }
    }
    if (filter === 'playlist') {
      return { items: term ? matchingPlaylists(term, library.playlists) : [], stale: false, pending: false, failed: false, catalogFailed: false, unavailable: false, retry: () => {} }
    }
    // Until the filter's own first page arrives, the mixed list's rows of that kind stand in.
    const standIn = pages.items === null && allItems && !all.stale ? allItems.filter(item => item.type === filter) : null
    return {
      items: pages.items ?? standIn, stale: pages.items !== null && pages.stale, pending: pages.loadingMore || (standIn !== null && pages.loading),
      failed: pages.failed, catalogFailed: pages.catalogFailed, unavailable: false, retry: pages.retry,
      hasMore: pages.hasMore, loadMore: pages.loadMore,
    }
  }, [all, pages, filter, term, library.playlists])

  const choose = (item: SearchItem, items: readonly SearchItem[]) => {
    if (term) recents.add({ type: 'query', query: term })
    recents.add(item)
    switch (item.type) {
      case 'artist': return void navigate(`/artist/${item.artist.id}`)
      case 'album': return void navigate(`/album/${item.album.id}`)
      case 'playlist': return void navigate(`/playlist/${item.playlist.id}`)
      case 'track': {
        const playable = (track: TrackSummary) => isPlayable(track, viewer)
        if (playable(item.track)) {
          // The song, then the songs listed after it: playing on continues through what was found.
          const { tracks, start } = searchQueue(items, item.track, playable)
          return controls.playTracks(tracks, start, searchContext(term))
        }
        if (item.track.album) void navigate(`/album/${item.track.album.id}`)
      }
    }
  }

  return (
    <SearchView
      query={typed}
      onQueryChange={q => {
        setTyped(q)
        show(q, filter)
      }}
      filter={filter}
      onFilterChange={next => show(typed, next)}
      list={list}
      recents={recents.list}
      onRemoveRecent={recents.remove}
      onClearRecents={recents.clear}
      genres={genres}
      onBrowseGenre={genre => void navigate(`/library?${new URLSearchParams({ filter: 'albums', genre })}`)}
      onChoose={choose}
      onSearchRecent={q => {
        setTyped(q)
        show(q, filter)
      }}
    />
  )
}

/** Where a filter chip goes: the filter, with the chosen sort kept for when it applies again. */
function libraryHref(filter: LibraryFilterName, params: URLSearchParams) {
  const next = new URLSearchParams({ filter })
  const sort = params.get('sort')
  if (isLibrarySort(sort) && sort !== 'recent') next.set('sort', sort)
  return `/library?${next}`
}

/**
 * The old list pages (`/library/albums`, …) and links from before the combined Library: the
 * combined view with that filter chosen, keeping a sort or genre they carried.
 */
export function LibraryRedirect({ filter }: { filter: LibraryFilterName }) {
  const [params] = useSearchParams()
  const next = new URLSearchParams(params)
  next.set('filter', filter)
  return <Navigate to={`/library?${next}`} replace />
}

/** `/library` without a filter opens on the one this browser chose last. */
export function LibraryPage() {
  const [params] = useSearchParams()
  const filter = params.get('filter')
  if (!isLibraryFilter(filter)) {
    const next = new URLSearchParams(params)
    next.set('filter', readLibraryFilter())
    return <Navigate to={`/library?${next}`} replace />
  }
  return <CombinedLibrary filter={filter} />
}

/** How many songs after the one played go into the queue with it. */
const SONGS_AFTER = 300
const songsContext = { type: 'other', id: null, title: 'Songs' } as const
const likedContext = { type: 'liked', id: null, title: 'Liked Songs' } as const

const listCount = <T,>(list: { data?: InfiniteData<ListPage<T>>; hasNextPage: boolean }, one: string) => {
  if (!list.data) return undefined
  const count = itemsOf(list.data).length
  return list.hasNextPage ? `${count.toLocaleString()}+ ${one}s` : plural(count, one)
}

/**
 * The combined Library. Only the lists the filter shows are loaded. Two characters or more
 * search the whole library on the server (playlists are only ever filtered here); one
 * character filters what is loaded.
 */
function CombinedLibrary({ filter }: { filter: LibraryFilterName }) {
  const user = useCurrentUser()
  const library = useLibrary()
  const controls = usePlayerControls()
  const { playAlbum, playPlaylist } = usePlayCollections()
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useState(readLibraryLayout)
  const [query, setQuery] = useState('')
  const chosen = params.get('sort')
  const sort = sortFor(filter, isLibrarySort(chosen) ? chosen : 'recent')
  const genre = params.get('genre') ?? undefined

  useEffect(() => writeLibraryFilter(filter), [filter])

  const showsPlaylists = filter === 'all' || filter === 'playlists'
  const showsAlbums = filter === 'all' || filter === 'albums'
  const albums = useLibraryList('albums', { sort, genre }, showsAlbums)
  // The server lists artists by name whatever the order asked for.
  const artists = useLibraryList('artists', { sort: 'recent' }, filter === 'artists')
  const songs = useLibraryList('tracks', { sort, genre }, filter === 'songs')
  const playlistList = usePlaylists()
  const playlists = playlistList.data?.items
  // Without the playlists, Liked Songs and the albums still show; the page says the rest failed.
  const playlistsFailed = showsPlaylists && !playlists && Boolean(playlistList.error)
  const liked = useLikedTracks()

  const searchText = filter === 'playlists' ? '' : query
  // A search keeps to the genre chosen, as the lists do; the artists' list takes no genre.
  const found = useLibraryMatches(searchText, filter === 'artists' ? undefined : genre)
  const searching = searchesServer(searchText)
  // The search's own failure, once it is done retrying: the list behind it may well have loaded.
  const searchFailed = searching && !found.pending && found.data === undefined && Boolean(found.error)
  const matched = searching ? found.data : undefined
  const listed = filter === 'artists' ? artists : filter === 'songs' ? songs : showsAlbums ? albums : null

  const items = useMemo((): LibraryItem[] | undefined => {
    if (filter === 'songs') return undefined
    const collections: LibraryItem[] = []
    if (showsPlaylists) {
      if (!playlists && !playlistsFailed) return undefined
      collections.push(
        ...[{ kind: 'liked' } as const, ...(playlists ?? []).map(playlist => ({ kind: 'playlist', playlist }) as const)]
          .filter(item => matches(query, item.kind === 'liked' ? 'Liked Songs' : item.playlist.name, item.kind === 'liked' ? '' : item.playlist.ownerName)),
      )
    }
    if (showsAlbums) {
      const list = searching ? matched?.albums : albums.data && itemsOf(albums.data).filter(album => matches(query, album.title, album.artistCredit))
      if (!list) return undefined
      collections.push(...list.map(album => ({ kind: 'album', album }) as const))
    }
    if (filter === 'artists') {
      const list = searching ? matched?.artists : artists.data && itemsOf(artists.data).filter(artist => matches(query, artist.name))
      if (!list) return undefined
      collections.push(...list.map(artist => ({ kind: 'artist', artist }) as const))
    }
    return collections
  }, [filter, showsPlaylists, showsAlbums, playlists, playlistsFailed, query, searching, matched, albums.data, artists.data])

  const tracks = useMemo(() => {
    if (filter !== 'songs') return undefined
    if (searching) return matched?.tracks
    return songs.data && itemsOf(songs.data).filter(track => matches(query, track.title, track.artistCredit, track.album?.title ?? ''))
  }, [filter, searching, matched, songs.data, query])

  // While another sort's list stands in, its cursor is not this list's.
  const hasNextPage = Boolean(listed?.hasNextPage && !listed.isPlaceholderData)
  const { fetchNextPage, isFetchingNextPage } = listed ?? {}
  const onEndReached = useCallback(() => {
    if (!searching && hasNextPage && !isFetchingNextPage) void fetchNextPage?.()
  }, [searching, hasNextPage, isFetchingNextPage, fetchNextPage])

  if (listed?.error && !listed.data) return <ErrorPage error={listed.error} onRetry={() => void listed.refetch()} />

  const matchedCount = !matched ? 0 : filter === 'songs' ? matched.tracks.length : filter === 'artists' ? matched.artists.length : matched.albums.length
  const count = filter === 'albums' ? listCount(albums, 'album')
    : filter === 'artists' ? listCount(artists, 'artist')
      : filter === 'songs' ? listCount(songs, 'song')
        // Liked Songs is listed, and labeled, as a playlist, so it counts as one.
        : filter === 'playlists' && playlists ? plural(playlists.length + 1, 'playlist') : undefined
  const setParam = (key: string, value: string | undefined) => setParams(current => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })

  const playSong = async (index: number) => {
    // Filtered, the matches on screen are what is played.
    if (query.trim()) controls.playTracks(tracks ?? [], index, songsContext)
    else controls.playTracks(await loadItems(songs, index + SONGS_AFTER), index, songsContext)
  }

  return (
    <LibraryView
      filter={filter}
      filterHref={name => libraryHref(name, params)}
      sort={sort}
      sorts={sortsFor(filter)}
      onSortChange={next => setParam('sort', next === 'recent' ? undefined : next)}
      layout={layout}
      onLayoutChange={next => {
        setLayout(next)
        writeLibraryLayout(next)
      }}
      query={query}
      onQueryChange={setQuery}
      genre={genre}
      onClearGenre={() => setParam('genre', undefined)}
      items={items}
      tracks={tracks}
      // All lists collections; a search also finds songs, which follow them rather than going unsaid.
      songMatches={filter === 'all' ? matched?.tracks : undefined}
      playlistsFailure={playlistsFailed ? { error: playlistList.error, onRetry: () => void playlistList.refetch() } : undefined}
      searchFailure={searchFailed ? { error: found.error, onRetry: () => void found.refetch() } : undefined}
      count={count}
      likedCount={liked.data ? listCount(liked, 'song') : undefined}
      libraryEmpty={Boolean(albums.data && !itemsOf(albums.data).length && !genre)}
      pending={searching && found.pending}
      capped={searching && matchedCount >= LIBRARY_MATCH_LIMIT}
      loadingMore={!searching && Boolean(listed?.isFetchingNextPage)}
      onEndReached={onEndReached}
      canAddMusic={user.role === 'admin'}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
      onPlayLiked={() => void loadItems(liked, 5000).then(list => controls.playTracks(list, 0, likedContext))}
      onPlaySong={index => void playSong(index)}
      onNewPlaylist={() => library.newPlaylist()}
    />
  )
}
