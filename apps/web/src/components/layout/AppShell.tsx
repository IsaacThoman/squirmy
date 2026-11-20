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
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { TopBar } from './TopBar'

type AppShellProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" under Liked Songs. */
  likedCount: string
  onLogout: () => void
}

/**
 * Sidebar, scrolling main view, queue panel and player bar on wide screens; tabs and a
 * mini-player below 768px, as on the phone.
 */
export function AppShell({ user, playlists, likedCount, onLogout }: AppShellProps) {
  const player = usePlayer()
  const library = useLibrary()
  const { pathname } = useLocation()
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ open: boolean; pane: NowPlayingPane }>({ open: false, pane: 'art' })
  const track = player.state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setLiked('track', track.id, !liked) }
  const elsewhere = playingElsewhere(player.state)

  useEffect(() => { scroller?.scrollTo({ top: 0 }) }, [pathname, scroller])

  return (
    <div
      className={cn(
        'relative flex h-dvh overflow-hidden [--player-height:calc(8.25rem+env(safe-area-inset-bottom))]',
        elsewhere ? 'md:[--player-height:7.25rem]' : 'md:[--player-height:5.5rem]',
      )}
    >
      <div className="hidden md:block">
        <Sidebar user={user} playlists={playlists} likedCount={likedCount} />
      </div>

      <main
        ref={setScroller}
        className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain pb-(--player-height) [--gutter:1rem] md:[--gutter:1.5rem] lg:[--gutter:2rem]"
      >
        <ScrollContainerContext value={scroller}>
          <TopBar user={user} onLogout={onLogout} />
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
