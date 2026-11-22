import type { PlaylistSummary, User } from '@squirmy/contracts'
import { Dialog as NavigationDialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { NowPlaying, type NowPlayingPane } from '@/components/player/NowPlaying'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueuePanel } from '@/components/player/Queue'
import { readLocalStorage, writeLocalStorage } from '@/lib/local-storage'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { playingElsewhere, usePlayer } from '@/player/player-context'
import { ScrollContainerContext } from './scroll-context'
import { ShellNotices } from './ShellNotices'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

const compactSidebarKey = 'squirmy.sidebar.compact'

type AppShellProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" under Liked Songs. */
  likedCount: string
  onLogout: () => void
  onOpenSettings: (trigger: HTMLButtonElement | null) => void
}

/**
 * The sidebar and drawer share navigation. Playback stays mounted across every page.
 */
export function AppShell({ user, playlists, likedCount, onLogout, onOpenSettings }: AppShellProps) {
  const player = usePlayer()
  const library = useLibrary()
  const { pathname } = useLocation()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [compact, setCompact] = useState(() => readLocalStorage(compactSidebarKey) === 'true')
  const drawerTrigger = useRef<HTMLButtonElement>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ open: boolean; pane: NowPlayingPane }>({ open: false, pane: 'art' })
  const track = player.state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setLiked('track', track.id, !liked) }
  const elsewhere = playingElsewhere(player.state)

  useEffect(() => { scroller?.scrollTo({ top: 0 }) }, [pathname, scroller])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 48rem)')
    const closeDrawer = () => { if (desktop.matches) setDrawerOpen(false) }
    desktop.addEventListener('change', closeDrawer)
    return () => desktop.removeEventListener('change', closeDrawer)
  }, [])

  const toggleSidebar = () => {
    writeLocalStorage(compactSidebarKey, String(!compact))
    setCompact(!compact)
  }
  const dismissDrawer = () => setDrawerOpen(false)
  const sidebarProps = { user, playlists, likedCount, onLogout }

  return (
    <div
      className={cn(
        'relative flex h-dvh overflow-hidden [--player-height:calc(5rem+env(safe-area-inset-bottom))]',
        elsewhere ? 'md:[--player-height:7.25rem]' : 'md:[--player-height:5.5rem]',
      )}
    >
      <div className="hidden shrink-0 border-r border-stroke pb-(--player-height) md:block">
        <Sidebar {...sidebarProps} compact={compact} onToggle={toggleSidebar} onOpenSettings={onOpenSettings} />
      </div>

      <main
        ref={setScroller}
        className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain pb-(--player-height) [--gutter:1rem] md:[--gutter:1.5rem] lg:[--gutter:2rem]"
      >
        <ScrollContainerContext value={scroller}>
          <NavigationDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <TopBar navigationTrigger={drawerTrigger} />
            <NavigationDialog.Portal>
              <NavigationDialog.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
              <NavigationDialog.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 left-0 z-40 w-[min(20rem,calc(100vw-2.5rem))] animate-fade-in border-r border-stroke bg-sheet pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-float focus:outline-none md:hidden"
              >
                <NavigationDialog.Title className="sr-only">Navigation</NavigationDialog.Title>
                <Sidebar
                  {...sidebarProps}
                  onDismiss={dismissDrawer}
                  onOpenSettings={() => { dismissDrawer(); onOpenSettings(drawerTrigger.current) }}
                />
              </NavigationDialog.Content>
            </NavigationDialog.Portal>
          </NavigationDialog.Root>
          <Outlet />
        </ScrollContainerContext>
      </main>

      {queueOpen && (
        <div className="absolute bottom-[calc(var(--player-height)+0.5rem)] right-2 top-2 z-20 hidden w-[22rem] animate-enter overflow-hidden rounded-3xl shadow-float md:block xl:static xl:z-auto xl:h-full xl:w-[21rem] xl:animate-none xl:rounded-none xl:border-l xl:border-stroke xl:pb-(--player-height) xl:shadow-none">
          <QueuePanel player={player} onClose={() => setQueueOpen(false)} />
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 hidden md:block">
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
      <div className="fixed inset-x-0 bottom-2 z-30 pb-[env(safe-area-inset-bottom)] md:hidden">
        <MiniPlayer player={player} onOpenNowPlaying={() => setNowPlaying({ open: true, pane: 'art' })} />
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
