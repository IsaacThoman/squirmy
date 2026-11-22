/**
 * Route containers for the music pages. Each one gathers its data with TanStack Query and
 * hands it to a view in components/views.
 */
import type { HomeSection, Page as ListPage, PlaylistDetail } from '@squirmy/contracts'
import { queryKeys } from '@squirmy/contracts'
import { useMutation, useQueryClient, type InfiniteData, type UseQueryResult } from '@tanstack/react-query'
import { CloudOff, Compass } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { moveItem } from '@/lib/reorder'
import { useCachedSummary } from '@/api/prefetch'
import {
  isNotFound, itemsOf, LIBRARY_MATCH_LIMIT, loadItems, searchesServer, useAlbum, useArtist, useGenres, useHome, useLibraryList, useLibraryMatches,
  useLikedTracks, usePlaylist, usePlaylists, useWants,
} from '@/api/queries'
import { useApi } from '@/api/services'
import { useMergedSearch } from '@/api/use-search'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { Page } from '@/components/layout/Page'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { CollectionSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { AlbumView } from '@/components/views/AlbumView'
import { ArtistView } from '@/components/views/ArtistView'
import { HomeView, type ScanProgress } from '@/components/views/HomeView'
import { LibraryView, type LibraryItem } from '@/components/views/LibraryView'
import {
  isLibraryFilter, isLibrarySort, matches, readLibraryFilter, readLibraryLayout, sortFor, sortsFor, writeLibraryFilter, writeLibraryLayout,
  type LibraryFilterName,
} from '@/components/views/library-state'
import { LikedView, PlaylistView } from '@/components/views/PlaylistView'
import { AlbumPreview, ArtistPreview } from '@/components/views/Previews'
import { SearchView } from '@/components/views/SearchView'
import { WantlistView } from '@/components/views/WantlistView'
import { canFetch } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { useUrlDraft } from '@/lib/use-url-draft'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { usePlayerControls, type PlayOptions } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'
import { useServerEvent } from '@/realtime/realtime-context'

export function NotFoundPage() {
  return (
    <Page>
      <EmptyState icon={<Compass />} title="Nothing here" description="This page does not exist, or the music it pointed to is gone." action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>} />
    </Page>
  )
}

function ErrorPage({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Page>
      <EmptyState icon={<CloudOff />} title="This page did not load" description={errorMessage(error)} action={<Button variant="primary" onClick={onRetry}>Try again</Button>} />
    </Page>
  )
}

/** A page's main query: its skeleton while loading, "Nothing here" for a 404, a retry for other failures. */
function Loaded<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton: ReactNode; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return children(query.data)
  if (query.error) return isNotFound(query.error) ? <NotFoundPage /> : <ErrorPage error={query.error} onRetry={() => void query.refetch()} />
  return skeleton
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
  if (home.error) return <ErrorPage error={home.error} onRetry={() => void home.refetch()} />
  const sections = home.data?.sections
  const albums = (id: string) => {
    const section = sections?.find(candidate => candidate.id === id)
    return section?.kind === 'albums' ? section.albums : []
  }
  // What was played last leads, then what was added; the sections follow in the server's order.
  const featured = albums('recently-played')[0] ?? albums('recently-added')[0] ?? null
  return (
    <HomeView
      featured={featured}
      sections={sections}
      empty={Boolean(sections) && sections!.every(isEmptySection)}
      canAddMusic={user.role === 'admin'}
      canFindMusic={canFetch(user)}
      scan={scan}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
    />
  )
}

const isEmptySection = (section: HomeSection) => (
  section.kind === 'albums' ? !section.albums.length
    : section.kind === 'artists' ? !section.artists.length
      : section.kind === 'playlists' ? !section.playlists.length
        : !section.tracks.length
)

export function AlbumPage() {
  const id = useParams().id ?? ''
  const query = useAlbum(id)
  const summary = useCachedSummary('album', id, query.data === undefined)
  return <Loaded query={query} skeleton={summary ? <AlbumPreview album={summary} /> : <CollectionSkeleton />}>{album => <AlbumView key={album.id} album={album} />}</Loaded>
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

export function PlaylistPage() {
  const id = useParams().id ?? ''
  return <Loaded query={usePlaylist(id)} skeleton={<CollectionSkeleton />}>{playlist => <EditablePlaylist key={playlist.id} playlist={playlist} />}</Loaded>
}

function EditablePlaylist({ playlist }: { playlist: PlaylistDetail }) {
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
  const remove = useMutation({
    mutationFn: () => api.userdata.deletePlaylist(playlist.id),
    onSuccess: () => {
      toast({ title: 'Playlist deleted', description: playlist.name })
      void navigate('/library?filter=playlists', { replace: true })
      queryClient.removeQueries({ queryKey: key })
      return queryClient.invalidateQueries({ queryKey: queryKeys.playlists(), exact: true })
    },
  })
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
        description="The playlist goes away for everyone. The songs stay in the library."
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

export function SearchPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { playAlbum } = usePlayCollections()
  const genres = useGenres().data?.items.map(genre => genre.name) ?? []
  const query = params.get('q') ?? ''
  const [typed, setTyped] = useUrlDraft(query)
  const search = useMergedSearch(typed)
  return (
    <SearchView
      query={typed}
      onQueryChange={q => {
        setTyped(q)
        setParams(q ? { q } : {}, { replace: true })
      }}
      search={search}
      genres={genres}
      onBrowseGenre={genre => void navigate(`/library?${new URLSearchParams({ filter: 'albums', genre })}`)}
      onPlayAlbum={album => void playAlbum(album)}
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
  const playlists = usePlaylists().data?.items
  const liked = useLikedTracks()

  const searchText = filter === 'playlists' ? '' : query
  const found = useLibraryMatches(searchText)
  const searching = searchesServer(searchText)
  const matched = searching ? found.data : undefined
  const listed = filter === 'artists' ? artists : filter === 'songs' ? songs : showsAlbums ? albums : null

  const items = useMemo((): LibraryItem[] | undefined => {
    if (filter === 'songs') return undefined
    const collections: LibraryItem[] = []
    if (showsPlaylists) {
      if (!playlists) return undefined
      collections.push(
        ...[{ kind: 'liked' } as const, ...playlists.map(playlist => ({ kind: 'playlist', playlist }) as const)]
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
  }, [filter, showsPlaylists, showsAlbums, playlists, query, searching, matched, albums.data, artists.data])

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

  const error = listed?.error ?? (searching ? found.error : null)
  if (error && !listed?.data) return <ErrorPage error={error} onRetry={() => void (searching ? found.refetch() : listed?.refetch())} />

  const matchedCount = !matched ? 0 : filter === 'songs' ? matched.tracks.length : filter === 'artists' ? matched.artists.length : matched.albums.length
  const count = filter === 'albums' ? listCount(albums, 'album')
    : filter === 'artists' ? listCount(artists, 'artist')
      : filter === 'songs' ? listCount(songs, 'song')
        : filter === 'playlists' && playlists ? plural(playlists.length, 'playlist') : undefined
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
