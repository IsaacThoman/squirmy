/**
 * The container of the app shell: the sidebar's playlists, the search dialog and the settings
 * dialog, each with the data it needs.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Bookmark, Disc3, Heart, House, ListMusic, MicVocal, Music2, Search, ShieldCheck, Upload } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { itemsOf, loadItems, searchQuery, useLikedTracks, usePlaylists } from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { useCurrentUser } from '@/auth/session'
import { AppShell, type SearchDialogState, type SettingsDialogState } from '@/components/layout/AppShell'
import { SearchDialog, type SearchChoice, type SearchDestination } from '@/components/layout/SearchDialog'
import { isSettingsSection, useSettingsDialog } from '@/components/settings/settings-dialog'
import { canUploadMusic, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useDebounced } from '@/lib/use-debounced'
import { useOnDemand } from '@/player/on-demand-context'
import { usePlayer } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'

// Settings are a separate download; most visits never open them.
const SettingsDialogHost = lazy(() => import('@/pages/settings').then(module => ({ default: module.SettingsDialogHost })))

const likedLabel = (count: number, more: boolean) => (more ? `${count.toLocaleString()}+` : plural(count, 'song'))

export function ShellPage() {
  const user = useCurrentUser()
  const logout = useLogout()
  const { controls } = usePlayer()
  const { playPlaylist } = usePlayCollections()
  const playlists = usePlaylists().data?.items ?? []
  const liked = useLikedTracks()
  const playLiked = async () => controls.playTracks(await loadItems(liked, 5000), 0, { type: 'liked', id: null, title: 'Liked Songs' })
  return (
    <AppShell
      user={user}
      onLogout={logout}
      playlists={playlists}
      likedCount={liked.data ? likedLabel(itemsOf(liked.data).length, liked.hasNextPage) : ''}
      onPlayPlaylist={playlist => void playPlaylist(playlist)}
      onPlayLiked={() => void playLiked()}
      renderSearch={state => <SearchDialogHost {...state} />}
      renderSettings={state => <SettingsDialogMount {...state} />}
    />
  )
}

/** Loads the settings when they are first opened, and keeps them mounted so closing animates. */
function SettingsDialogMount(state: SettingsDialogState) {
  const [mounted, setMounted] = useState(state.open)
  if (state.open && !mounted) setMounted(true)
  return mounted ? <Suspense fallback={null}><SettingsDialogHost {...state} /></Suspense> : null
}

function SearchDialogHost({ open, onOpenChange }: SearchDialogState) {
  const api = useApi()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const { controls } = usePlayer()
  const { canRequest } = useOnDemand()
  const [query, setQuery] = useState('')
  const term = useDebounced(query.trim(), 200, '')
  const search = useQuery({ ...searchQuery(api, 'library', term), enabled: open && term.length > 0, placeholderData: keepPreviousData, meta: { silent: true } })
  const close = () => {
    onOpenChange(false)
    setQuery('')
  }
  const destinations = useMemo<SearchDestination[]>(() => [
    { label: 'Home', to: '/', icon: House },
    { label: 'Search and browse genres', to: '/search', icon: Search },
    { label: 'Albums', to: '/library/albums', icon: Disc3 },
    { label: 'Artists', to: '/library/artists', icon: MicVocal },
    { label: 'Songs', to: '/library/songs', icon: Music2 },
    { label: 'Playlists', to: '/library/playlists', icon: ListMusic },
    { label: 'Liked Songs', to: '/liked', icon: Heart },
    { label: 'Wantlist', to: '/wantlist', icon: Bookmark },
    ...(canUploadMusic(user) ? [{ label: 'Add music', to: '/imports', icon: Upload }] : []),
    ...(user.role === 'admin' ? [{ label: 'Admin panel', to: '/admin', icon: ShieldCheck }] : []),
  ], [user])

  const choose = (choice: SearchChoice) => {
    close()
    switch (choice.kind) {
      case 'artist': return void navigate(`/artist/${choice.artist.id}`)
      case 'album': return void navigate(`/album/${choice.album.id}`)
      case 'destination': return void navigate(choice.destination.to)
      case 'all': return void navigate(`/search?q=${encodeURIComponent(choice.query)}`)
      case 'track':
        if (isPlayable(choice.track, canRequest)) controls.playTracks([choice.track], 0, { type: 'search', id: null, title: 'Search' })
        else if (choice.track.album) void navigate(`/album/${choice.track.album.id}`)
        else void navigate(`/search?q=${encodeURIComponent(choice.track.title)}`)
    }
  }

  if (!open) return null
  return (
    <SearchDialog
      open
      onOpenChange={next => { if (!next) close() }}
      query={query}
      onQueryChange={setQuery}
      results={query.trim() ? search.data ?? null : null}
      loading={query.trim().length > 0 && (search.isFetching || term !== query.trim())}
      destinations={destinations}
      canPlay={track => isPlayable(track, canRequest)}
      onChoose={choose}
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
