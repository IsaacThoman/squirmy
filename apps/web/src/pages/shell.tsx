/**
 * The container of the app shell: the sidebar's playlists, the search dialog and the settings
 * dialog, each with the data it needs.
 */
import { searchContext } from '@squirmy/client-core'
import type { PlaylistSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Bookmark, Disc3, Heart, House, Library, ListMusic, MicVocal, Music2, Search, ShieldCheck, Upload } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { HOVER_DELAY_MS, prefetchPage, usePrefetchStartPages, type PrefetchTarget } from '@/api/prefetch'
import { itemsOf, loadItems, useLikedTracks, usePlaylists } from '@/api/queries'
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
import { toast } from '@/lib/toast'
import { useEventCallback } from '@/lib/use-event-callback'
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
  const { playPlaylist } = usePlayCollections()
  const playlists = usePlaylists().data?.items ?? noPlaylists
  const liked = useLikedTracks()
  const onPlayPlaylist = useEventCallback((playlist: PlaylistSummary) => void playPlaylist(playlist))
  const onPlayLiked = useEventCallback(() => {
    void loadItems(liked, 5000).then(tracks => controls.playTracks(tracks, 0, { type: 'liked', id: null, title: 'Liked Songs' }))
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
  const search = useMergedSearch(query)
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
    const target: PrefetchTarget | null = choice.kind === 'artist' ? { kind: 'artist', id: choice.artist.id }
      : choice.kind === 'album' ? { kind: 'album', id: choice.album.id }
        : choice.kind === 'track' && !isPlayable(choice.track, viewer) && choice.track.album ? { kind: 'album', id: choice.track.album.id }
          : null
    if (target) intentTimer.current = setTimeout(() => prefetchPage(client, api, target), HOVER_DELAY_MS)
  })

  const choose = (choice: SearchChoice) => {
    close()
    switch (choice.kind) {
      case 'artist': return void navigate(`/artist/${choice.artist.id}`)
      case 'album': return void navigate(`/album/${choice.album.id}`)
      case 'destination': return void navigate(choice.destination.to)
      case 'all': return void navigate(`/search?q=${encodeURIComponent(choice.query)}`)
      case 'track':
        if (isPlayable(choice.track, viewer)) controls.playTracks([choice.track], 0, searchContext(typed))
        else if (choice.track.album) void navigate(`/album/${choice.track.album.id}`)
        else void navigate(`/search?q=${encodeURIComponent(choice.track.title)}`)
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
      loading={typed.length > 0 && (!search.results || search.stale || search.catalogPending)}
      destinations={destinations}
      canPlay={track => isPlayable(track, viewer)}
      isDimmed={choice => (choice.kind === 'album' ? albumPresentation(choice.album, viewer) === 'dimmed' : !choice.artist.inLibrary && !canFetch(viewer))}
      onChoose={choose}
      onIntent={onIntent}
    />
  )
}

/** Where Last.fm sends the browser back to, as `/settings?lastfm=`. */
const lastFmReturns: Record<string, { title: string; description?: string }> = {
  connected: { title: 'Connected to Last.fm' },
  denied: { title: 'Last.fm was not connected', description: 'The connection was not approved.' },
  invalid_state: { title: 'That Last.fm link expired', description: 'Start connecting again.' },
  error: { title: 'Last.fm did not answer', description: 'Try again in a moment.' },
}

/**
 * `/settings` and `/settings/<section>`: settings are a dialog, so these addresses open it over
 * the home page. Last.fm returns here with `?lastfm=`, which becomes a notice.
 */
export function SettingsRoute() {
  const { openSettings } = useSettingsDialog()
  const { section } = useParams()
  const [params] = useSearchParams()
  const lastFm = params.get('lastfm')
  useEffect(() => {
    if (lastFm !== null) toast(lastFmReturns[lastFm] ?? lastFmReturns.error)
    openSettings(lastFm !== null ? 'scrobbling' : isSettingsSection(section) ? section : undefined)
  }, [lastFm, section, openSettings])
  return <Navigate to="/" replace />
}
