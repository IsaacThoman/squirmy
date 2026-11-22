import type { PlaylistSummary, User } from '@squirmy/contracts'
import { PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router'
import { NowPlaying, type NowPlayingPane } from '@/components/player/NowPlaying'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueuePanel } from '@/components/player/Queue'
import { SettingsDialogContext, type SettingsSection } from '@/components/settings/settings-dialog'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { playingElsewhere, usePlayer } from '@/player/player-context'
import { ScrollContainerContext } from './scroll-context'
import { ShellNotices } from './ShellNotices'
import { Sidebar } from './Sidebar'
import { SidebarResizeHandle } from './SidebarResizeHandle'
import {
  applySidebarWidth, clampSidebarWidth, MOBILE_QUERY, readSidebarCollapsed, readSidebarWidth, sidebarMaxWidth, writeSidebarCollapsed, writeSidebarWidth,
} from './sidebar-state'

export type SettingsDialogState = { open: boolean; section: SettingsSection; onOpenChange: (open: boolean) => void; onSectionChange: (section: SettingsSection) => void }
export type SearchDialogState = { open: boolean; onOpenChange: (open: boolean) => void }

type AppShellProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" beside Liked Songs. */
  likedCount: string
  onPlayPlaylist: (playlist: PlaylistSummary) => void
  onPlayLiked: () => void
  onLogout: () => void
  /** The dialogs fetch their own data, so the pages render them; the shell says when they are open. */
  renderSearch: (state: SearchDialogState) => ReactNode
  renderSettings: (state: SettingsDialogState) => ReactNode
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The elements Tab reaches in `root`, in order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(element => element.tabIndex >= 0 && !element.closest('[inert]'))
}

const isEditable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[contenteditable]:not([contenteditable="false"])'))

/**
 * The signed-in app: the sidebar, the page, the queue beside it and the player along the bottom.
 * Below 768px the sidebar is a drawer and the player a small bar.
 */
export function AppShell({ user, playlists, likedCount, onPlayPlaylist, onPlayLiked, onLogout, renderSearch, renderSettings }: AppShellProps) {
  const player = usePlayer()
  const library = useLibrary()
  const { pathname } = useLocation()
  const frame = useRef<HTMLDivElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // The whole frame, sidebar included; unlike the page it does not change as the sidebar animates.
  const [frameWidth, setFrameWidth] = useState(() => window.innerWidth)
  // The open sidebar's width is kept as set; what shows is clamped to the room there is now.
  const [preferredWidth, setPreferredWidth] = useState(readSidebarWidth)
  const sidebarWidth = clampSidebarWidth(preferredWidth, frameWidth)
  // Off for a frame when the layout switches between drawer and sidebar, and while a drag sizes it.
  const [transitions, setTransitions] = useState(true)
  const [tracking, setTracking] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({ open: false, section: 'playback' })
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<{ open: boolean; pane: NowPlayingPane }>({ open: false, pane: 'art' })

  const track = player.state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setLiked('track', track.id, !liked) }
  const elsewhere = playingElsewhere(player.state)

  const openSettings = useCallback((section: SettingsSection = 'playback') => {
    setDrawerOpen(false)
    setSettings({ open: true, section })
  }, [])
  const settingsController = useMemo(() => ({ openSettings }), [openSettings])

  const setSidebarCollapsed = (next: boolean) => {
    setCollapsed(next)
    writeSidebarCollapsed(next)
  }
  // The latest toggle, for the shortcut's listener.
  const toggleSidebar = useRef(() => {})
  useEffect(() => {
    toggleSidebar.current = () => (mobile ? setDrawerOpen(open => !open) : setSidebarCollapsed(!collapsed))
  })

  useEffect(() => { scroller?.scrollTo({ top: 0 }) }, [pathname, scroller])
  useEffect(() => { setDrawerOpen(false) }, [pathname])

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY)
    const update = () => {
      setTransitions(false)
      setMobile(query.matches)
      setDrawerOpen(false)
    }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (transitions) return
    let inner = 0
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setTransitions(true)) })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [transitions])

  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => setFrameWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => { applySidebarWidth(sidebarWidth) }, [sidebarWidth])

  // Toasts and notices float above the player, wherever they are rendered.
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--player-height', mobile ? (track ? '4rem' : '0px') : elsewhere ? '6.5rem' : '4.5rem')
    return () => { root.style.removeProperty('--player-height') }
  }, [mobile, elsewhere, track])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        setDrawerOpen(false)
        setSearchOpen(open => !open)
      } else if (key === 'b' && !isEditable(event.target)) {
        event.preventDefault()
        toggleSidebar.current()
      } else if (key === ',') {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  // The open drawer is modal: it takes focus, keeps Tab inside it, closes on Escape and gives focus back.
  const drawerShown = mobile && drawerOpen
  const opener = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!drawerShown) return
    const openerButton = opener.current
    const drawer = () => frame.current?.querySelector<HTMLElement>(':scope > aside') ?? null
    const focusFirst = requestAnimationFrame(() => {
      const panel = drawer()
      if (panel && !panel.contains(document.activeElement)) tabbables(panel)[0]?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = drawer()
      if (event.defaultPrevented || !panel) return
      if (event.key === 'Escape') return setDrawerOpen(false)
      if (event.key !== 'Tab') return
      const items = tabbables(panel)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // A menu or dialog opened from the drawer renders in a portal and traps focus itself.
      if (active && !panel.contains(active) && active.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', onKeyDown)
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (!active || active === document.body || drawer()?.contains(active)) openerButton?.focus()
      })
    }
  }, [drawerShown])

  return (
    <SettingsDialogContext value={settingsController}>
      <a
        href="#main-content"
        className="sr-only rounded-lg border bg-popover text-sm font-medium text-popover-foreground shadow-lg outline-none focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:px-3 focus:py-2 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={event => {
          event.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to main content
      </a>
      <div ref={frame} className="relative flex h-dvh overflow-hidden">
        {mobile && (
          <button
            type="button"
            // A pointer target only: the drawer's own close button and Escape close it from the keyboard.
            aria-hidden
            tabIndex={-1}
            onClick={() => setDrawerOpen(false)}
            className={cn('fixed inset-0 z-30 bg-black/55 transition-opacity duration-200', drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0')}
          />
        )}
        <Sidebar
          user={user}
          playlists={playlists}
          likedCount={likedCount}
          collapsed={!mobile && collapsed}
          mobile={mobile}
          mobileOpen={drawerOpen}
          transitions={transitions && !tracking}
          onToggle={() => (mobile ? setDrawerOpen(false) : setSidebarCollapsed(!collapsed))}
          onNavigate={() => setDrawerOpen(false)}
          onOpenSettings={() => openSettings()}
          onPlayPlaylist={onPlayPlaylist}
          onPlayLiked={onPlayLiked}
          onLogout={onLogout}
        />
        {!mobile && (
          <SidebarResizeHandle
            width={sidebarWidth}
            maxWidth={sidebarMaxWidth(frameWidth)}
            collapsed={collapsed}
            onTrackingChange={setTracking}
            onOpenChange={open => setSidebarCollapsed(!open)}
            onWidthChange={width => {
              setPreferredWidth(width)
              writeSidebarWidth(width)
            }}
          />
        )}

        {/* Everything behind the open drawer is inert. */}
        <div className="flex min-w-0 flex-1 flex-col" inert={drawerShown}>
          <div className="relative flex min-h-0 flex-1">
            {mobile && (
              <button
                ref={opener}
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open sidebar"
                aria-expanded={drawerOpen}
                className="absolute left-2 top-2 z-30 flex size-8 items-center justify-center rounded-lg bg-background/70 text-foreground outline-none backdrop-blur-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelLeftOpen aria-hidden className="size-5" />
              </button>
            )}
            <main
              id="main-content"
              ref={setScroller}
              tabIndex={-1}
              className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain outline-none [--gutter:1rem] md:[--gutter:1.5rem]"
            >
              <ScrollContainerContext value={scroller}>
                <Outlet />
              </ScrollContainerContext>
            </main>

            {queueOpen && (
              <aside
                aria-label="Queue"
                className="absolute inset-y-2 right-2 z-20 hidden w-[22rem] animate-enter overflow-hidden rounded-lg border bg-background shadow-lg md:block xl:static xl:z-auto xl:w-[21rem] xl:animate-none xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none"
              >
                <QueuePanel player={player} onClose={() => setQueueOpen(false)} />
              </aside>
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
              onToggleLyrics={() => setNowPlaying(now => (now.open && now.pane === 'lyrics' ? { open: false, pane: 'art' } : { open: true, pane: 'lyrics' }))}
              onOpenNowPlaying={() => setNowPlaying({ open: true, pane: 'art' })}
            />
          </div>
          <div className="shrink-0 md:hidden">
            <MiniPlayer player={player} onOpenNowPlaying={() => setNowPlaying({ open: true, pane: 'art' })} />
          </div>
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
      {renderSearch({ open: searchOpen, onOpenChange: setSearchOpen })}
      {renderSettings({
        open: settings.open,
        section: settings.section,
        onOpenChange: open => setSettings(current => ({ ...current, open })),
        onSectionChange: section => setSettings(current => ({ ...current, section })),
      })}
    </SettingsDialogContext>
  )
}
