/**
 * The container of the app shell: the sidebar's playlists, the search dialog and the settings
 * dialog, each with the data it needs.
 */
import { searchContext, searchQueue } from '@squirmy/client-core'
import type { PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Bookmark, Disc3, Heart, House, Library, ListMusic, MicVocal, Music2, Search, ShieldCheck, Upload } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { HOVER_DELAY_MS, prefetchPage, usePrefetchStartPages, type PrefetchTarget } from '@/api/prefetch'
import { itemsOf, useLikedTracks, usePlaylists } from '@/api/queries'
import { useApi } from '@/api/services'
import { useMergedSearch } from '@/api/use-search'
import { useLogout } from '@/auth/actions'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { AppShell, type SearchDialogState, type SettingsDialogState } from '@/components/layout/AppShell'
import { ErrorBoundary, ErrorMessage } from '@/components/layout/ErrorBoundary'
import { SearchDialog, type SearchChoice, type SearchDestination } from '@/components/layout/SearchDialog'
import { isSettingsSection, useSettingsDialog } from '@/components/settings/settings-dialog'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { albumPresentation, canFetch, canUploadMusic, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { useRecentSearches } from '@/lib/recent-searches'
import { useEventCallback } from '@/lib/use-event-callback'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'

// Settings are a separate download; most visits never open them, so it waits until the page is idle.
const loadSettings = () => import('@/pages/settings')
const SettingsDialogHost = lazy(() => loadSettings().then(module => ({ default: module.SettingsDialogHost })))

const likedLabel = (count: number, more: boolean) => (more ? `${count.toLocaleString()}+` : plural(count, 'song'))
const noPlaylists: PlaylistSummary[] = []

// The shell is memoized: these keep one identity, so it renders only when what it shows changes.
const renderSearch = (state: SearchDialogState) => state.open && <SearchDialogHost {...state} />
const renderSettings = (state: SettingsDialogState) => <SettingsDialogMount {...state} />

export function ShellPage() {
  const user = useCurrentUser()
  const logout = useLogout()
  const controls = usePlayerControls()
  const { playPlaylist, playLoaded } = usePlayCollections()
  const playlists = usePlaylists().data?.items ?? noPlaylists
  const liked = useLikedTracks()
  const onPlayPlaylist = useEventCallback((playlist: PlaylistSummary) => void playPlaylist(playlist))
  const onPlayLiked = useEventCallback(() => {
    void playLoaded(liked, 5000, tracks => controls.playTracks(tracks, 0, { type: 'liked', id: null, title: 'Liked Songs' }, { collection: true }))
  })
  const onLogout = useEventCallback(logout)

  useEffect(() => {
    // The first ⌘, then opens at once; without it a slow connection shows nothing until the download ends.
    const preload = () => void loadSettings().catch(() => {})
    if (typeof requestIdleCallback === 'function') {
      const idle = requestIdleCallback(preload, { timeout: 5000 })
      return () => cancelIdleCallback(idle)
    }
    const timer = setTimeout(preload, 2000)
    return () => clearTimeout(timer)
  }, [])
  usePrefetchStartPages()

  return (
    <AppShell
      user={user}
      onLogout={onLogout}
      playlists={playlists}
      likedCount={liked.data ? likedLabel(itemsOf(liked.data).length, liked.hasNextPage) : ''}
      onPlayPlaylist={onPlayPlaylist}
      onPlayLiked={onPlayLiked}
      renderSearch={renderSearch}
      renderSettings={renderSettings}
    />
  )
}

/** Loads the settings when they are first opened, and keeps them mounted so closing animates. */
function SettingsDialogMount(state: SettingsDialogState) {
  const [mounted, setMounted] = useState(state.open)
  if (state.open && !mounted) setMounted(true)
  if (!mounted) return null
  return (
    // A download that failed (a new version was deployed) says so in the dialog; closing it clears the error.
    <ErrorBoundary
      resetKey={state.open}
      fallback={({ error, retry }) => (
        <Dialog open={state.open} onOpenChange={state.onOpenChange}>
          <DialogContent title="Settings"><ErrorMessage error={error} onRetry={retry} className="py-6" /></DialogContent>
        </Dialog>
      )}
    >
      <Suspense fallback={null}><SettingsDialogHost {...state} /></Suspense>
    </ErrorBoundary>
  )
}

/** Mounted only while the dialog is open, so each search starts with nothing typed and nothing found. */
function SearchDialogHost({ onOpenChange }: SearchDialogState) {
  const api = useApi()
  const navigate = useNavigate()
  const wantlistEnabled = useWantlistEnabled()
  const user = useCurrentUser()
  const controls = usePlayerControls()
  const viewer = useViewer()
  const [query, setQuery] = useState('')
  const typed = query.trim()
  const library = useLibrary()
  const recents = useRecentSearches(user.id)
  const search = useMergedSearch(query, { playlists: library.playlists })
  const close = () => onOpenChange(false)
  const destinations = useMemo<SearchDestination[]>(() => [
    { label: 'Home', to: '/', icon: House },
    { label: 'Search and browse genres', to: '/search', icon: Search },
    { label: 'Library', to: '/library', icon: Library },
    { label: 'Albums', to: '/library?filter=albums', icon: Disc3 },
    { label: 'Artists', to: '/library?filter=artists', icon: MicVocal },
    { label: 'Songs', to: '/library?filter=songs', icon: Music2 },
    { label: 'Playlists', to: '/library?filter=playlists', icon: ListMusic },
    { label: 'Liked Songs', to: '/liked', icon: Heart },
    ...(wantlistEnabled ? [{ label: 'Wantlist', to: '/wantlist', icon: Bookmark }] : []),
    ...(canUploadMusic(user) ? [{ label: 'Add music', to: '/imports', icon: Upload }] : []),
    ...(user.role === 'admin' ? [{ label: 'Admin panel', to: '/admin', icon: ShieldCheck }] : []),
  ], [user, wantlistEnabled])

  // The page a highlighted row opens starts loading once the highlight rests on it.
  const client = useQueryClient()
  const intentTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(intentTimer.current), [])
  const onIntent = useEventCallback((choice: SearchChoice) => {
    clearTimeout(intentTimer.current)
    const item = choice.kind === 'result' ? choice.item : null
    const target: PrefetchTarget | null = item?.type === 'artist' ? { kind: 'artist', id: item.artist.id }
      : item?.type === 'album' ? { kind: 'album', id: item.album.id }
        : item?.type === 'track' && !isPlayable(item.track, viewer) && item.track.album ? { kind: 'album', id: item.track.album.id }
          : null
    if (target) intentTimer.current = setTimeout(() => prefetchPage(client, api, target), HOVER_DELAY_MS)
  })

  const choose = (choice: SearchChoice) => {
    close()
    if (choice.kind === 'destination') return void navigate(choice.destination.to)
    if (choice.kind === 'all') return void navigate(`/search?q=${encodeURIComponent(choice.query)}`)
    const { item } = choice
    // Results opened here also appear in Recently viewed on the search page.
    recents.add(item)
    switch (item.type) {
      case 'artist': return void navigate(`/artist/${item.artist.id}`)
      case 'album': return void navigate(`/album/${item.album.id}`)
      case 'playlist': return void navigate(`/playlist/${item.playlist.id}`)
      case 'track': {
        const playable = (track: TrackSummary) => isPlayable(track, viewer)
        if (playable(item.track)) {
          // As on the search page: the song, then the songs found after it.
          const { tracks, start } = searchQueue(search.results?.items ?? [], item.track, playable)
          return controls.playTracks(tracks, start, searchContext(typed))
        }
        if (item.track.album) return void navigate(`/album/${item.track.album.id}`)
        return void navigate(`/search?q=${encodeURIComponent(item.track.title)}`)
      }
    }
  }

  return (
    <SearchDialog
      open
      onOpenChange={next => { if (!next) close() }}
      query={query}
      onQueryChange={setQuery}
      results={search.results}
      stale={search.stale}
      loading={typed.length > 0 && !search.failed && (!search.results || search.stale || search.catalogPending)}
      failed={search.failed}
      catalogFailed={search.catalogFailed}
      onRetry={search.retry}
      destinations={destinations}
      canPlay={track => isPlayable(track, viewer)}
      isDimmed={item => (item.type === 'album' ? albumPresentation(item.album, viewer) === 'dimmed' : !item.artist.inLibrary && !canFetch(viewer))}
      onChoose={choose}
      onIntent={onIntent}
    />
  )
}

/**
 * `/settings` and `/settings/<section>`: settings are a dialog, so these addresses open it over
 * the home page. Last.fm returns here with `?lastfm=`: the Scrobbling section opens and says
 * what Last.fm answered.
 */
export function SettingsRoute() {
  const { openSettings } = useSettingsDialog()
  const { section } = useParams()
  const [params] = useSearchParams()
  const lastFm = params.get('lastfm')
  useEffect(() => {
    if (lastFm !== null) openSettings('scrobbling', { lastFm })
    else openSettings(isSettingsSection(section) ? section : undefined)
  }, [lastFm, section, openSettings])
  return <Navigate to="/" replace />
}
