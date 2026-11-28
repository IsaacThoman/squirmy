/**
 * Route containers for the music pages. Each one gathers its data with TanStack Query and
 * hands it to a view in components/views.
 */
import { filterKind, searchContext, searchFilters, type SearchFilter, type SearchItem } from '@squirmy/client-core'
import type { HomeSection, Page as ListPage, PlaylistDetail } from '@squirmy/contracts'
import { queryKeys } from '@squirmy/contracts'
import { useMutation, useQueryClient, type InfiniteData, type UseQueryResult } from '@tanstack/react-query'
import { Compass } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { moveItem } from '@/lib/reorder'
import { useCachedSummary } from '@/api/prefetch'
import {
  isNotFound, itemsOf, LIBRARY_MATCH_LIMIT, searchesServer, useNextPage, useAlbum, useArtist, useArtistReleases, useCollectionList, useGenres, useHome, useLibraryList, useLibraryMatches,
  useLikedTracks, useMix, usePlaylist, usePlaylists, useWants,
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
  defaultSort, isLibraryFilter, isLibrarySort, matches, pinTarget, readLibraryFilter, readLibraryLayout, sortFor, sortsFor, writeLibraryFilter, writeLibraryLayout,
  type LibraryFilterName,
} from '@/components/views/library-state'
import { mixMenuEntries } from '@/components/music/mix-menu'
import { LikedView, MixView, PlaylistView } from '@/components/views/PlaylistView'
import { AlbumPreview, ArtistPreview } from '@/components/views/Previews'
import { SearchView, type SearchList } from '@/components/views/SearchView'
import { WantlistView } from '@/components/views/WantlistView'
import { canFetch, isArtistSectionKey, isPlayable } from '@/lib/catalog'
import { usePageTitle } from '@/lib/document-title'
import { plural } from '@/lib/format'
import { useRecentSearches } from '@/lib/recent-searches'
import { useUrlDraft } from '@/lib/use-url-draft'
import { FAILURE_MS, useLibrary } from '@/player/library-context'
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
  const { playAlbum, playPlaylist, playMix, playLoaded } = usePlayCollections()
  const controls = usePlayerControls()
  // The sidebar's Liked Songs keeps this list loaded already.
  const liked = useLikedTracks()
  const playLiked = () => void playLoaded(liked, 5000, tracks => controls.playTracks(tracks, 0, { type: 'liked', id: null, title: 'Liked Songs' }, { collection: true }))
  const user = useCurrentUser()
  const home = useHome()
  const scan = useScanProgress()
  // A failed refetch keeps the last answer on screen; only a first answer that failed replaces the page.
  if (home.error && !home.data) return <ErrorPage error={home.error} retrying={home.isFetching} onRetry={() => void home.refetch()} />
  return (
    <HomeView
      sections={home.data?.sections}
      empty={Boolean(home.data) && home.data!.sections.every(isEmptySection)}
      canAddMusic={user.role === 'admin'}
      canFindMusic={canFetch(user)}
      scan={scan}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
      onPlayMix={mix => void playMix(mix)}
      onPlayLiked={playLiked}
      onStartRadio={radio => controls.startRadio({ type: radio.seed, id: radio.id })}
    />
  )
}

const isEmptySection = (section: HomeSection) => {
  switch (section.kind) {
    case 'albums': return !section.albums.length
    case 'artists': return !section.artists.length
    case 'playlists': return !section.playlists.length
    case 'tracks': return !section.tracks.length
    case 'items': return !section.items.length
    // A kind from a newer server than this app shows nothing.
    default: return true
  }
}

/** `/mix/:id`: a mix made for the user, read-only, from Home's Made for you. */
export function MixPage() {
  const id = useParams().id ?? ''
  const query = useMix(id)
  const controls = usePlayerControls()
  const library = useLibrary()
  const viewer = useViewer()
  return (
    <Loaded query={query} skeleton={<CollectionSkeleton />}>
      {mix => {
        const context = { type: 'mix', id: mix.id, title: mix.name } as const
        const playable = mix.tracks.filter(track => isPlayable(track, viewer))
        return (
          <MixView
            key={mix.id}
            mix={mix}
            menu={mixMenuEntries({
              onPlay: () => controls.playTracks(mix.tracks, 0, context, { collection: true }),
              onShuffle: () => controls.playTracks(mix.tracks, 0, context, { shuffle: true, collection: true }),
              onEnqueue: placement => controls.enqueue(playable, placement),
              playlists: library.playlists,
              onAddToPlaylist: playlist => (playlist ? library.addToPlaylist(playlist, mix.tracks) : library.newPlaylist(mix.tracks)),
            })}
          />
        )
      }}
    </Loaded>
  )
}

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
  const next = useNextPage(releases)
  if (!known || isNotFound(artist.error) || isNotFound(releases.error)) return <NotFoundPage />
  if (releases.error && !releases.data) return <ErrorPage error={releases.error} retrying={releases.isFetching} onRetry={() => void releases.refetch()} />
  return (
    <ArtistReleasesView
      key={`${id}/${section}`}
      artist={artist.data ?? summary}
      artistId={id}
      section={section}
      total={artist.data?.sections?.find(candidate => candidate.key === section)?.total}
      albums={releases.data && itemsOf(releases.data)}
      onEndReached={next.onEndReached}
      moreFailure={next.moreFailure}
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
  })
  const deleted = useRef(false)
  const remove = useMutation({
    mutationFn: () => api.userdata.deletePlaylist(playlist.id),
    onMutate: () => onDeleting(true),
    onError: () => onDeleting(false),
    onSuccess: () => {
      deleted.current = true
      void navigate('/library?filter=playlists', { replace: true })
      return queryClient.invalidateQueries({ queryKey: queryKeys.playlists(), exact: true })
    },
  })
  // Dropped from the cache once the page has gone: removed while it shows, the page would ask for it again.
  useEffect(() => () => {
    if (deleted.current) queryClient.removeQueries({ queryKey: queryKeys.playlist(playlist.id), exact: true })
  }, [queryClient, playlist.id])
  // Moves and removals show at once; the server's answer, or a refetch after a failure, replaces them.
  // A failure is said above the songs for a few seconds, as they go back to where they were.
  const [failure, setFailure] = useState<string>()
  const failureTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(failureTimer.current), [])
  const refused = (message: string) => {
    clearTimeout(failureTimer.current)
    setFailure(message)
    failureTimer.current = setTimeout(() => setFailure(undefined), FAILURE_MS)
    return refetch()
  }
  const move = useMutation({
    mutationFn: ({ itemId, toIndex }: { itemId: string; toIndex: number }) => api.userdata.movePlaylistItem(playlist.id, { itemId, toIndex }),
    onSuccess: save,
    onError: () => refused('Couldn’t move the song. Try again.'),
  })
  const drop = useMutation({
    mutationFn: ({ itemId }: { itemId: string; title: string }) => api.userdata.removePlaylistItem(playlist.id, itemId),
    onSuccess: save,
    onError: (_error, { title }) => refused(`Couldn’t remove “${title}”. Try again.`),
  })

  return (
    <>
      <PlaylistView
        playlist={playlist}
        owned={playlist.ownerId === user.id}
        onEdit={() => setDialog('edit')}
        onTogglePublic={() => update.mutateAsync({ isPublic: !playlist.isPublic })}
        onDelete={() => setDialog('delete')}
        onMove={(from, to) => {
          if (to < 0 || to >= playlist.items.length || from === to) return
          change(detail => ({ ...detail, items: moveItem(detail.items, from, to) }))
          move.mutate({ itemId: playlist.items[from].itemId, toIndex: to })
        }}
        onRemove={index => {
          const { itemId, track } = playlist.items[index]
          change(detail => ({ ...detail, items: detail.items.filter(item => item.itemId !== itemId) }))
          drop.mutate({ itemId, title: track.title })
        }}
        failure={failure}
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
  const { playLoaded } = usePlayCollections()
  const context = { type: 'liked', id: null, title: 'Liked Songs' } as const
  const { hasNextPage, onEndReached, moreFailure } = useNextPage(liked)
  const play = (index: number, options?: PlayOptions) => playLoaded(liked, 5000, tracks => controls.playTracks(tracks, index, context, options))
  return (
    <Loaded query={liked} skeleton={<CollectionSkeleton />}>
      {data => (
        <LikedView
          tracks={itemsOf(data)}
          complete={!hasNextPage}
          onEndReached={onEndReached}
          moreFailure={moreFailure}
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
  const genreList = useGenres()
  // Null until known, so the page's guidance does not flash before the genres arrive; none if they did not load.
  const genres = useMemo(() => genreList.data?.items.map(genre => genre.name) ?? (genreList.isError ? [] : null), [genreList.data, genreList.isError])
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
        failed: all.failed, catalogFailed: all.catalogFailed, unavailable: all.unavailable, retry: all.retry, retrying: all.retrying,
      }
    }
    if (filter === 'playlist') {
      return { items: term ? matchingPlaylists(term, library.playlists) : [], stale: false, pending: false, failed: false, catalogFailed: false, unavailable: false, retry: () => {} }
    }
    // Until the filter's own first page arrives, the mixed list's rows of that kind stand in.
    const standIn = pages.items === null && allItems && !all.stale ? allItems.filter(item => item.type === filter) : null
    return {
      items: pages.items ?? standIn, stale: pages.items !== null && pages.stale, pending: pages.loadingMore || (standIn !== null && pages.loading),
      failed: pages.failed, catalogFailed: pages.catalogFailed, unavailable: false, retry: pages.retry, retrying: pages.loading,
      hasMore: pages.hasMore, loadMore: pages.loadMore, moreFailed: pages.moreFailed, moreError: pages.error,
    }
  }, [all, pages, filter, term, library.playlists])

  const choose = (item: SearchItem) => {
    recents.add(item)
    switch (item.type) {
      case 'artist': return void navigate(`/artist/${item.artist.id}`)
      case 'album': return void navigate(`/album/${item.album.id}`)
      case 'playlist': return void navigate(`/playlist/${item.playlist.id}`)
      case 'track': {
        // The song on its own: when it ends, autoplay goes on with music like it, not the rest of what was found.
        if (isPlayable(item.track, viewer)) return controls.playTracks([item.track], 0, searchContext(term))
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
    />
  )
}

/** The filters a genre narrows: the albums (alone or under All) and the songs on them. */
const GENRE_FILTERS: readonly LibraryFilterName[] = ['all', 'albums', 'songs']

/**
 * Where a filter chip goes: the filter, with the chosen sort kept for when it applies again, and
 * the genre kept between the filters it narrows until it is cleared. Playlists and artists take
 * no genre, so they leave it behind rather than show a chip that changes nothing.
 */
function libraryHref(filter: LibraryFilterName, params: URLSearchParams, base = '/library') {
  const next = new URLSearchParams({ filter })
  const sort = params.get('sort')
  // Each filter opens in its own default, so a sort is carried only when it is not that.
  if (isLibrarySort(sort) && sort !== defaultSort(filter)) next.set('sort', sort)
  const genre = params.get('genre')
  if (genre && GENRE_FILTERS.includes(filter)) next.set('genre', genre)
  return `${base}?${next}`
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

/** What a one-letter filter of All matches an item by: the title and the line under it. */
function itemText(item: LibraryItem): string[] {
  switch (item.kind) {
    case 'liked': return ['Liked Songs']
    case 'playlist': return [item.playlist.name, item.playlist.ownerName]
    case 'album': return [item.album.title, item.album.artistCredit]
    case 'artist': return [item.artist.name]
  }
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
  const { playAlbum, playPlaylist, playLoaded } = usePlayCollections()
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useState(readLibraryLayout)
  const [query, setQuery] = useState('')
  const chosen = params.get('sort')
  const sort = sortFor(filter, isLibrarySort(chosen) ? chosen : null)
  const genre = params.get('genre') ?? undefined

  useEffect(() => writeLibraryFilter(filter), [filter])

  const showsPlaylists = filter === 'all' || filter === 'playlists'
  const showsAlbums = filter === 'all' || filter === 'albums'
  // All is one list from the server, in the sort's order; a search of it adds the albums and artists found.
  const all = useLibraryList('items', { sort, genre }, filter === 'all')
  const albums = useLibraryList('albums', { sort, genre }, filter === 'albums')
  // The server lists artists by name whatever the order asked for.
  const artists = useLibraryList('artists', { sort: 'recent' }, filter === 'artists')
  const songs = useLibraryList('tracks', { sort, genre }, filter === 'songs')
  const playlistList = usePlaylists()
  const playlists = playlistList.data?.items
  // Without the playlists, Liked Songs and the albums still show; the page says the rest failed.
  // Under All the server lists them, so only a search of All (which lists them here) needs them.
  const playlistsFailed = showsPlaylists && (filter === 'playlists' || searchesServer(query)) && !playlists && Boolean(playlistList.error)
  const liked = useLikedTracks()

  const searchText = filter === 'playlists' ? '' : query
  // A search keeps to the genre chosen, as the lists do; the artists' list takes no genre.
  const found = useLibraryMatches(searchText, filter === 'artists' ? undefined : genre)
  const searching = searchesServer(searchText)
  // The search's own failure, once it is done retrying: the list behind it may well have loaded.
  const searchFailed = searching && !found.pending && found.data === undefined && Boolean(found.error)
  const matched = searching ? found.data : undefined
  const listed = filter === 'all' ? all : filter === 'artists' ? artists : filter === 'songs' ? songs : filter === 'albums' ? albums : null
  // The list's first answer failed. The page stays: the chips, and under All the playlists, are still usable.
  const listFailed = Boolean(listed?.error && !listed.data)
  const albumsFailed = showsAlbums && listFailed

  const items = useMemo((): LibraryItem[] | undefined => {
    if (filter === 'songs') return undefined
    if (filter === 'all' && !searching) {
      if (listFailed) return []
      return all.data && itemsOf(all.data).filter(item => matches(query, ...itemText(item)))
    }
    const collections: LibraryItem[] = []
    if (showsPlaylists) {
      if (!playlists && !playlistsFailed) return undefined
      collections.push(
        ...[{ kind: 'liked' } as const, ...(playlists ?? []).map(playlist => ({ kind: 'playlist', playlist }) as const)]
          .filter(item => matches(query, item.kind === 'liked' ? 'Liked Songs' : item.playlist.name, item.kind === 'liked' ? '' : item.playlist.ownerName)),
      )
    }
    if (showsAlbums && !(albumsFailed && !searching)) {
      const list = searching ? matched?.albums : albums.data && itemsOf(albums.data).filter(album => matches(query, album.title, album.artistCredit))
      if (!list) return undefined
      collections.push(...list.map(album => ({ kind: 'album', album }) as const))
    }
    // All shows artists beside the rest, so a search of it finds them there too.
    if (filter === 'artists' || filter === 'all') {
      const list = searching ? matched?.artists : artists.data && itemsOf(artists.data).filter(artist => matches(query, artist.name))
      if (!list) return undefined
      collections.push(...list.map(artist => ({ kind: 'artist', artist }) as const))
    }
    return collections
  }, [filter, showsPlaylists, showsAlbums, albumsFailed, listFailed, playlists, playlistsFailed, query, searching, matched, all.data, albums.data, artists.data])

  const tracks = useMemo(() => {
    if (filter !== 'songs') return undefined
    if (searching) return matched?.tracks
    return songs.data && itemsOf(songs.data).filter(track => matches(query, track.title, track.artistCredit, track.album?.title ?? ''))
  }, [filter, searching, matched, songs.data, query])

  const { onEndReached, loadingMore, moreFailure } = useNextPage(listed ?? undefined, searching)

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

  const api = useApi()
  const queryClient = useQueryClient()
  // The list moves once the server has the pin, so the menu waits for both.
  const pinItem = async (item: LibraryItem, pinned: boolean) => {
    const [kind, id] = pinTarget(item)
    await (pinned ? api.userdata.pin(kind, id) : api.userdata.unpin(kind, id))
    await queryClient.invalidateQueries({ queryKey: queryKeys.libraryItems() })
  }

  const playSong = async (index: number) => {
    // Filtered, the matches on screen are what is played.
    if (query.trim()) controls.playTracks(tracks ?? [], index, songsContext)
    else await playLoaded(songs, index + SONGS_AFTER, list => controls.playTracks(list, index, songsContext))
  }

  return (
    <LibraryView
      filter={filter}
      filterHref={name => libraryHref(name, params)}
      sort={sort}
      sorts={sortsFor(filter)}
      onSortChange={next => setParam('sort', next === defaultSort(filter) ? undefined : next)}
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
      listFailure={listFailed ? { error: listed!.error, retrying: listed!.isFetching, onRetry: () => void listed!.refetch() } : undefined}
      searchFailure={searchFailed ?{ error: found.error, onRetry: () => void found.refetch() } : undefined}
      count={count}
      likedCount={liked.data ? listCount(liked, 'song') : undefined}
      // Liked Songs is always listed under All, so the library is empty when nothing else is.
      libraryEmpty={!genre && Boolean(filter === 'all'
        ? all.data && !all.hasNextPage && itemsOf(all.data).every(item => item.kind === 'liked')
        : albums.data && !itemsOf(albums.data).length)}
      pending={searching && found.pending}
      capped={searching && matchedCount >= LIBRARY_MATCH_LIMIT}
      loadingMore={loadingMore}
      moreFailure={moreFailure}
      onEndReached={onEndReached}
      canAddMusic={user.role === 'admin'}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
      onPlayLiked={() => void playLoaded(liked, 5000, list => controls.playTracks(list, 0, likedContext, { collection: true }))}
      onPlaySong={index => void playSong(index)}
      onNewPlaylist={() => library.newPlaylist()}
      onPin={pinItem}
    />
  )
}

type ServerFilter = 'albums' | 'artists' | 'songs'
const isServerFilter = (value: string | null): value is ServerFilter => value === 'albums' || value === 'artists' || value === 'songs'

/** `/collection`: the server's music, Home's See all. Opens on its albums. */
export function CollectionPage() {
  const [params] = useSearchParams()
  const filter = params.get('filter')
  if (!isServerFilter(filter)) {
    const next = new URLSearchParams(params)
    next.set('filter', 'albums')
    return <Navigate to={`/collection?${next}`} replace />
  }
  return <ServerMusic filter={filter} />
}

/**
 * All of the server's music, whatever is in the user's library: the Library's view over the
 * server's lists, with its sorts, genre and search, and no pins or playlists. Two characters
 * or more search on the server, as the Library does; one filters what is loaded.
 */
function ServerMusic({ filter }: { filter: ServerFilter }) {
  usePageTitle('On this server')
  const user = useCurrentUser()
  const controls = usePlayerControls()
  const { playAlbum, playLoaded } = usePlayCollections()
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useState(readLibraryLayout)
  const [query, setQuery] = useState('')
  const chosen = params.get('sort')
  const sort = sortFor(filter, isLibrarySort(chosen) ? chosen : null)
  const genre = params.get('genre') ?? undefined

  const albums = useCollectionList('albums', { sort, genre }, filter === 'albums')
  // Artists come by name whatever the order asked for.
  const artists = useCollectionList('artists', { sort: 'recent' }, filter === 'artists')
  const songs = useCollectionList('tracks', { sort, genre }, filter === 'songs')
  const found = useLibraryMatches(query, filter === 'artists' ? undefined : genre)
  const searching = searchesServer(query)
  const searchFailed = searching && !found.pending && found.data === undefined && Boolean(found.error)
  const matched = searching ? found.data : undefined
  const listed = filter === 'artists' ? artists : filter === 'songs' ? songs : albums
  const listFailed = Boolean(listed.error && !listed.data)

  const items = useMemo((): LibraryItem[] | undefined => {
    if (filter === 'songs') return undefined
    if (filter === 'albums') {
      if (listFailed && !searching) return []
      const list = searching ? matched?.albums : albums.data && itemsOf(albums.data).filter(album => matches(query, album.title, album.artistCredit))
      return list?.map(album => ({ kind: 'album', album }) as const)
    }
    const list = searching ? matched?.artists : artists.data && itemsOf(artists.data).filter(artist => matches(query, artist.name))
    return list?.map(artist => ({ kind: 'artist', artist }) as const)
  }, [filter, listFailed, searching, matched, albums.data, artists.data, query])

  const tracks = useMemo(() => {
    if (filter !== 'songs') return undefined
    if (searching) return matched?.tracks
    return songs.data && itemsOf(songs.data).filter(track => matches(query, track.title, track.artistCredit, track.album?.title ?? ''))
  }, [filter, searching, matched, songs.data, query])

  const { onEndReached, loadingMore, moreFailure } = useNextPage(listed, searching)

  const matchedCount = !matched ? 0 : filter === 'songs' ? matched.tracks.length : filter === 'artists' ? matched.artists.length : matched.albums.length
  const count = filter === 'albums' ? listCount(albums, 'album') : filter === 'artists' ? listCount(artists, 'artist') : listCount(songs, 'song')
  const setParam = (key: string, value: string | undefined) => setParams(current => {
    const next = new URLSearchParams(current)
    if (value) next.set(key, value)
    else next.delete(key)
    return next
  }, { replace: true })

  const playSong = async (index: number) => {
    if (query.trim()) controls.playTracks(tracks ?? [], index, songsContext)
    else await playLoaded(songs, index + SONGS_AFTER, list => controls.playTracks(list, index, songsContext))
  }

  return (
    <LibraryView
      server
      filter={filter}
      filterHref={name => libraryHref(name, params, '/collection')}
      sort={sort}
      sorts={sortsFor(filter)}
      onSortChange={next => setParam('sort', next === defaultSort(filter) ? undefined : next)}
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
      listFailure={listFailed ? { error: listed.error, retrying: listed.isFetching, onRetry: () => void listed.refetch() } : undefined}
      searchFailure={searchFailed ? { error: found.error, onRetry: () => void found.refetch() } : undefined}
      count={count}
      libraryEmpty={false}
      pending={searching && found.pending}
      capped={searching && matchedCount >= LIBRARY_MATCH_LIMIT}
      loadingMore={loadingMore}
      onEndReached={onEndReached}
      moreFailure={moreFailure}
      canAddMusic={user.role === 'admin'}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={() => {}}
      onPlayLiked={() => {}}
      onPlaySong={index => void playSong(index)}
      onNewPlaylist={() => {}}
    />
  )
}
