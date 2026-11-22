import type { PlaylistSummary, User } from '@squirmy/contracts'
import { Menu, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { NowPlaying, type NowPlayingPane } from '@/components/player/NowPlaying'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueuePanel } from '@/components/player/Queue'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { playingElsewhere, usePlayer } from '@/player/player-context'
import { ScrollContainerContext } from './scroll-context'
import { ShellNotices } from './ShellNotices'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { TopBar } from './TopBar'
import './workspace.css'

type AppShellProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" under Liked Songs. */
  likedCount: string
  onLogout: () => void
}

const collapseKey = 'squirmy.sidebar.collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(collapseKey) === 'true'
  } catch {
    return false
  }
}

export function AppShell({ user, playlists, likedCount, onLogout }: AppShellProps) {
  const player = usePlayer()
  const library = useLibrary()
  const { pathname } = useLocation()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ open: boolean; pane: NowPlayingPane }>({ open: false, pane: 'art' })
  const track = player.state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setLiked('track', track.id, !liked) }
  const elsewhere = playingElsewhere(player.state)

  useEffect(() => { scroller?.scrollTo({ top: 0 }) }, [pathname, scroller])
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 48rem)')
    const closeOnDesktop = (event: MediaQueryListEvent) => { if (event.matches) setNavigationOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  function toggleSidebar() {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(collapseKey, String(next))
    } catch {
      // The sidebar still works for this tab when storage is unavailable.
    }
  }

  return (
    <div
      className={cn(
        'workspace-shell relative h-dvh overflow-hidden',
        track ? '[--player-height:calc(8.25rem+env(safe-area-inset-bottom))]' : '[--player-height:calc(4rem+env(safe-area-inset-bottom))]',
        elsewhere ? 'md:[--player-height:7.25rem]' : 'md:[--player-height:5.5rem]',
      )}
    >
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-sheet focus:p-2">
        Skip to content
      </a>
      <div className="relative flex min-h-0 min-w-0 md:gap-2">
        <div className="hidden shrink-0 md:block">
          <Sidebar user={user} playlists={playlists} likedCount={likedCount} collapsed={collapsed} onCollapse={toggleSidebar} onLogout={onLogout} />
        </div>

        <main
          ref={setScroller}
          id="main-content"
          tabIndex={-1}
          className="workspace-main relative min-w-0 flex-1 overflow-y-auto overscroll-contain pb-(--player-height) [--gutter:1rem] md:pb-0 md:[--gutter:1.5rem] lg:[--gutter:2rem]"
        >
          <ScrollContainerContext value={scroller}>
            <Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
              <TopBar user={user} onLogout={onLogout} mobileNavigation={(
                <Dialog.Trigger asChild>
                  <IconButton label="Open navigation" tooltip={false} className="rounded-lg md:hidden"><Menu /></IconButton>
                </Dialog.Trigger>
              )} />
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/45 md:hidden" />
                <Dialog.Content aria-describedby={undefined} className="workspace-drawer fixed inset-y-0 left-0 z-50 w-[min(86vw,18rem)] animate-enter border-r border-stroke bg-sheet shadow-float outline-none md:hidden">
                  <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                  <Sidebar user={user} playlists={playlists} likedCount={likedCount} onNavigate={() => setNavigationOpen(false)} closeButton={(
                    <Dialog.Close asChild>
                      <IconButton label="Close navigation" tooltip={false} className="rounded-lg"><X /></IconButton>
                    </Dialog.Close>
                  )} />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <Outlet />
          </ScrollContainerContext>
        </main>

        {queueOpen && (
          <div className="workspace-queue absolute inset-y-0 right-0 z-20 hidden w-[min(22rem,44vw)] animate-enter overflow-hidden bg-sheet shadow-float md:block xl:static xl:z-auto xl:w-[21rem] xl:shrink-0 xl:animate-none xl:shadow-none">
            <QueuePanel player={player} onClose={() => setQueueOpen(false)} />
          </div>
        )}
      </div>

      <div className="z-30 hidden min-w-0 md:block">
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
      <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 md:hidden">
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
