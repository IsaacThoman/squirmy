/**
 * Route containers for the music pages. Each one gathers its data with TanStack Query and
 * hands it to a view in components/views.
 */
import type { AlbumSummary, LibrarySort, PlaybackContext, PlaylistDetail, PlaylistSummary, SearchResults, TrackSummary } from '@squirmy/contracts'
import { queryKeys } from '@squirmy/contracts'
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { CloudOff, Compass } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { moveItem } from '@/lib/reorder'
import {
  albumQuery, isNotFound, itemsOf, loadItems, playlistQuery, useAlbum, useArtist, useGenres, useHome, useLibraryList, useLikedTracks, usePlaylist,
  usePlaylists, useWants, type LibraryKind,
} from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { useCurrentUser } from '@/auth/session'
import { AppShell } from '@/components/layout/AppShell'
import { Page } from '@/components/layout/Page'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { CollectionSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { AlbumView } from '@/components/views/AlbumView'
import { ArtistView } from '@/components/views/ArtistView'
import { HomeView, type ScanProgress } from '@/components/views/HomeView'
import { LibraryAlbumsView, LibraryArtistsView, LibraryPlaylistsView, LibrarySongsView, type LibraryListProps } from '@/components/views/LibraryView'
import { LikedView, PlaylistView } from '@/components/views/PlaylistView'
import { SearchView } from '@/components/views/SearchView'
import { WantlistView } from '@/components/views/WantlistView'
import { plural } from '@/lib/format'
import { useUrlDraft } from '@/lib/use-url-draft'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { usePlayer, type PlayOptions } from '@/player/player-context'
import { useServerEvent } from '@/realtime/realtime-context'
import { useSettingsNavigation } from '@/components/layout/settings-navigation'
import { SettingsPage } from './account'

/** Play buttons on cards: the album or playlist is fetched (or read from the cache) first. */
function usePlayCollections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const { controls } = usePlayer()
  const play = async <T,>(query: { queryKey: QueryKey; queryFn: () => Promise<T> }, tracks: (data: T) => TrackSummary[], context: (data: T) => PlaybackContext) => {
    try {
      const data = await queryClient.fetchQuery(query)
      controls.playTracks(tracks(data), 0, context(data))
    } catch (error) {
      toast({ title: errorMessage(error) })
    }
  }
  return {
    playAlbum: (album: AlbumSummary) => play(albumQuery(api, album.id), detail => detail.discs.flatMap(disc => disc.tracks), detail => ({ type: 'album', id: detail.id, title: detail.title })),
    playPlaylist: (playlist: PlaylistSummary) => play(playlistQuery(api, playlist.id), detail => detail.items.map(item => item.track), detail => ({ type: 'playlist', id: detail.id, title: detail.name })),
  }
}

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
      <EmptyState icon={<CloudOff />} title="This page did not load" description={errorMessage(error)} action={<Button variant="primary" onClick={onRetry}>Try again</Button>} className="pt-24" />
    </Page>
  )
}

/** A page's main query: its skeleton while loading, "Nothing here" for a 404, a retry for other failures. */
function Loaded<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton: ReactNode; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) return children(query.data)
  if (query.error) return isNotFound(query.error) ? <NotFoundPage /> : <ErrorPage error={query.error} onRetry={() => void query.refetch()} />
  return skeleton
}

const likedLabel = (count: number, more: boolean) => (more ? `${count.toLocaleString()}+ songs` : plural(count, 'song'))

export function ShellPage() {
  const user = useCurrentUser()
  const logout = useLogout()
  const playlists = usePlaylists().data?.items ?? []
  const liked = useLikedTracks()
  const settings = useSettingsNavigation()
  return (
    <>
      <AppShell
        user={user}
        onLogout={logout}
        onOpenSettings={settings.show}
        playlists={playlists}
        likedCount={liked.data ? likedLabel(itemsOf(liked.data).length, liked.hasNextPage) : 'Playlist'}
      />
      {settings.open && <SettingsPage section={settings.section} onSectionChange={settings.select} onClose={settings.close} onCloseAutoFocus={settings.restoreFocus} />}
    </>
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
  if (home.error) return <ErrorPage error={home.error} onRetry={() => void home.refetch()} />
  const sections = home.data?.sections
  const albums = (id: string) => sections?.find(section => section.id === id && section.kind === 'albums')
  const added = albums('recently-added')
  const played = albums('recently-played')
  const featured = (played?.kind === 'albums' ? played.albums[0] : undefined) ?? (added?.kind === 'albums' ? added.albums[0] : undefined) ?? null
  return (
    <HomeView
      featured={featured}
      sections={sections}
      empty={Boolean(sections) && !added}
      canAddMusic={user.role === 'admin'}
      scan={scan}
      onPlayAlbum={album => void playAlbum(album)}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
    />
  )
}

export function AlbumPage() {
  const id = useParams().id ?? ''
  return <Loaded query={useAlbum(id)} skeleton={<CollectionSkeleton />}>{album => <AlbumView key={album.id} album={album} />}</Loaded>
}

export function ArtistPage() {
  const { playAlbum } = usePlayCollections()
  const id = useParams().id ?? ''
  return (
    <Loaded query={useArtist(id)} skeleton={<CollectionSkeleton round />}>
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
      void navigate('/library/playlists', { replace: true })
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
  const { controls } = usePlayer()
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
  const wants = useWants().data?.items
  return (
    <WantlistView
      albums={wants?.flatMap(item => (item.type === 'album' ? [item.album] : []))}
      tracks={wants?.flatMap(item => (item.type === 'track' ? [item.track] : []))}
    />
  )
}

/** `value`, once it has stopped changing for `delayMs`; `initial` until then. */
function useDebounced<T>(value: T, delayMs: number, initial: T): T {
  const [settled, setSettled] = useState(initial)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/** A search route that is not there yet answers 404: no results, and a note that search is missing. */
const orMissing = (request: Promise<SearchResults>) => request.catch((error: unknown) => {
  if (isNotFound(error)) return null
  throw error
})

export function SearchPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { playAlbum } = usePlayCollections()
  const genres = useGenres().data?.items.map(genre => genre.name) ?? []
  const query = params.get('q') ?? ''
  const [typed, setTyped] = useUrlDraft(query)
  // Typing into the top bar opens this page with the first letter; that alone is not a search.
  const term = useDebounced(query.trim(), 250, '')
  const search = (kind: 'library' | 'catalog') => ({
    queryKey: [...queryKeys.search(), kind, term],
    queryFn: ({ signal }: { signal: AbortSignal }) => orMissing(api.search[kind]({ q: term, limit: 20 }, { signal })),
    enabled: term.length > 0,
    staleTime: 60_000,
  })
  // The library answers fast, so its last results stay up while the next ones load;
  // the catalog is slower and its old results would be wrong for longer. A refresh of the
  // same search (a track fetched on demand changes it) keeps its results on screen.
  const library = useQuery({ ...search('library'), placeholderData: keepPreviousData })
  const catalog = useQuery(search('catalog'))
  const active = term.length > 0
  return (
    <SearchView
      query={typed}
      onQueryChange={q => {
        setTyped(q)
        setParams(q ? { q } : {}, { replace: true })
      }}
      library={active ? library.data ?? null : null}
      catalog={active ? catalog.data ?? null : null}
      libraryLoading={active && library.isPending}
      catalogLoading={active && catalog.isPending}
      unavailable={library.data === null && catalog.data === null}
      genres={genres}
      onBrowseGenre={genre => void navigate(`/library/albums?genre=${encodeURIComponent(genre)}`)}
      onPlayAlbum={album => void playAlbum(album)}
    />
  )
}

const sorts: LibrarySort[] = ['recent', 'title', 'artist', 'year']

/** Sort and genre live in the URL (`?sort=`, `?genre=`), as the API names them. */
function useLibraryFilter() {
  const [params, setParams] = useSearchParams()
  const value = params.get('sort') as LibrarySort | null
  const sort: LibrarySort = value && sorts.includes(value) ? value : 'recent'
  const genre = params.get('genre') ?? undefined
  const set = (next: { sort: LibrarySort; genre?: string }) => setParams({
    ...(next.sort === 'recent' ? {} : { sort: next.sort }),
    ...(next.genre ? { genre: next.genre } : {}),
  }, { replace: true })
  return { sort, genre, onSortChange: (next: LibrarySort) => set({ sort: next, genre }), onGenreChange: (next: string | undefined) => set({ sort, genre: next }) }
}

function useLibraryPage<K extends LibraryKind>(kind: K) {
  const user = useCurrentUser()
  const filter = useLibraryFilter()
  const genres = useGenres().data?.items.map(genre => genre.name)
  const list = useLibraryList(kind, { sort: filter.sort, genre: filter.genre })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list
  const props = {
    items: list.data && itemsOf(list.data),
    more: hasNextPage,
    onEndReached: () => { if (hasNextPage && !isFetchingNextPage) void fetchNextPage() },
    genres,
    canAddMusic: user.role === 'admin',
    ...filter,
  } satisfies Partial<LibraryListProps<unknown>>
  return { list, props }
}

export function LibraryAlbumsPage() {
  const { playAlbum } = usePlayCollections()
  const { list, props } = useLibraryPage('albums')
  if (list.error) return <ErrorPage error={list.error} onRetry={() => void list.refetch()} />
  return <LibraryAlbumsView {...props} onPlayAlbum={album => void playAlbum(album)} />
}

export function LibraryArtistsPage() {
  const { list, props } = useLibraryPage('artists')
  if (list.error) return <ErrorPage error={list.error} onRetry={() => void list.refetch()} />
  return <LibraryArtistsView {...props} />
}

/** How many songs after the one played go into the queue with it. */
const SONGS_AFTER = 300

export function LibrarySongsPage() {
  const { controls } = usePlayer()
  const { list, props } = useLibraryPage('tracks')
  if (list.error) return <ErrorPage error={list.error} onRetry={() => void list.refetch()} />
  const play = async (index: number) => controls.playTracks(await loadItems(list, index + SONGS_AFTER), index, { type: 'other', id: null, title: 'Songs' })
  return <LibrarySongsView {...props} onPlay={index => void play(index)} />
}

export function LibraryPlaylistsPage() {
  const { playPlaylist } = usePlayCollections()
  const library = useLibrary()
  const playlists = usePlaylists().data?.items
  return <LibraryPlaylistsView playlists={playlists} onPlayPlaylist={playlist => void playPlaylist(playlist)} onCreate={() => library.newPlaylist()} />
}
