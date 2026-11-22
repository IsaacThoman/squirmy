import type { PlaylistSummary, User } from '@squirmy/contracts'
import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { NowPlaying, type NowPlayingPane } from '@/components/player/NowPlaying'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueuePanel } from '@/components/player/Queue'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { playingElsewhere, usePlayer } from '@/player/player-context'
import { ScrollContainerContext } from './scroll-context'
import { ShellNotices } from './ShellNotices'
import { MobileSidebar, Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { TopBar } from './TopBar'

type AppShellProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" under Liked Songs. */
  likedCount: string
  onLogout: () => void
}

const sidebarPreferenceKey = 'squirmy-sidebar-collapsed'

function savedSidebarPreference(): boolean | null {
  try {
    const saved = window.localStorage.getItem(sidebarPreferenceKey)
    return saved === 'true' ? true : saved === 'false' ? false : null
  } catch {
    return null
  }
}

/** With no preference, keep the sidebar compact on intermediate-width desktop windows. */
function useSidebarCollapse() {
  const [preference, setPreference] = useState(savedSidebarPreference)
  const [compact, setCompact] = useState(() => !window.matchMedia('(min-width: 64rem)').matches)

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 64rem)')
    const update = (event: MediaQueryListEvent) => setCompact(!event.matches)
    wide.addEventListener('change', update)
    return () => wide.removeEventListener('change', update)
  }, [])

  const collapsed = preference ?? compact
  const toggle = () => {
    const next = !collapsed
    setPreference(next)
    try {
      window.localStorage.setItem(sidebarPreferenceKey, String(next))
    } catch {
      // The toggle still works for this window when browser storage is unavailable.
    }
  }
  return { collapsed, toggle }
}

/** Listening workspace with a shared transport and responsive navigation. */
export function AppShell({ user, playlists, likedCount, onLogout }: AppShellProps) {
  const player = usePlayer()
  const library = useLibrary()
  const { pathname } = useLocation()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ open: boolean; pane: NowPlayingPane }>({ open: false, pane: 'art' })
  const sidebar = useSidebarCollapse()
  const sidebarProps = { user, playlists, likedCount, onLogout }
  const track = player.state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setLiked('track', track.id, !liked) }
  const elsewhere = playingElsewhere(player.state)

  useEffect(() => { scroller?.scrollTo({ top: 0 }) }, [pathname, scroller])

  return (
    <div
      className={cn(
        'relative flex h-dvh flex-col overflow-hidden bg-background',
        track ? '[--player-height:calc(7.625rem+env(safe-area-inset-bottom))]' : '[--player-height:calc(3.625rem+env(safe-area-inset-bottom))]',
        elsewhere ? 'md:[--player-height:7.125rem]' : 'md:[--player-height:5.375rem]',
      )}
    >
      <div className="relative flex min-h-0 flex-1">
        <div className="hidden shrink-0 md:block">
          <Sidebar {...sidebarProps} collapsed={sidebar.collapsed} onToggle={sidebar.toggle} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col [--gutter:1rem] md:[--gutter:1.5rem] lg:[--gutter:2rem]">
          <TopBar user={user} onLogout={onLogout} mobileNavigation={<MobileSidebar {...sidebarProps} />} />
          <main ref={setScroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <ScrollContainerContext value={scroller}>
              <Outlet />
            </ScrollContainerContext>
          </main>
        </div>

        {queueOpen && (
          <div className="absolute inset-y-2 right-2 z-20 hidden w-[20rem] animate-enter overflow-hidden rounded-xl shadow-float md:block xl:static xl:w-[20rem] xl:shrink-0 xl:animate-none xl:rounded-none xl:border-l xl:border-stroke xl:shadow-none">
            <QueuePanel player={player} onClose={() => setQueueOpen(false)} />
          </div>
        )}
      </div>

      <div className="hidden shrink-0 md:block">
        <PlayerBar
          player={player}
          liked={liked}
          onToggleLike={toggleLike}
          queueOpen={queueOpen}
          onToggleQueue={() => setQueueOpen(open => !open)}
          lyricsOpen={nowPlaying.open && nowPlaying.pane === 'lyrics'}
          onToggleLyrics={() => setNowPlaying(now => now.open && now.pane === 'lyrics' ? { open: false, pane: 'art' } : { open: true, pane: 'lyrics' })}
          onOpenNowPlaying={() => setNowPlaying({ open: true, pane: 'art' })}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-2 md:hidden">
        <MiniPlayer player={player} onOpenNowPlaying={() => setNowPlaying({ open: true, pane: 'art' })} />
        <TabBar />
      </div>

      <NowPlaying
        player={player}
        open={nowPlaying.open}
        onOpenChange={open => setNowPlaying(now => ({ ...now, open }))}
        pane={nowPlaying.pane}
        onPaneChange={pane => setNowPlaying(now => ({ ...now, pane }))}
        liked={liked}
        onToggleLike={toggleLike}
      />
      <ShellNotices />
    </div>
  )
}
