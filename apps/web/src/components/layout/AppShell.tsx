import type { PlaylistSummary, User } from '@squirmy/contracts'
import { PanelLeftOpen } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Outlet, useLocation } from 'react-router'
import { NowPlaying, type NowPlayingPane } from '@/components/player/NowPlaying'
import { MiniPlayer, PlayerBar } from '@/components/player/PlayerBar'
import { QueuePanel } from '@/components/player/Queue'
import { SettingsDialogContext, type SettingsSection } from '@/components/settings/settings-dialog'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { usePlayer } from '@/player/player-context'
import { ErrorBoundary } from './ErrorBoundary'
import { ScrollContainerContext } from './scroll-context'
import { useScrollMemory } from './scroll-memory'
import { ShellNotices } from './ShellNotices'
import { Sidebar } from './Sidebar'
import { SidebarResizeHandle } from './SidebarResizeHandle'
import {
  applySidebarWidth, clampSidebarWidth, MOBILE_QUERY, readSidebarCollapsed, readSidebarWidth, SIDEBAR_MIN_WIDTH, sidebarMaxWidth, writeSidebarCollapsed, writeSidebarWidth,
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

type NowPlayingView = { open: boolean; pane: NowPlayingPane }

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The elements Tab reaches in `root`, in order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(element => element.tabIndex >= 0 && !element.closest('[inert]'))
}

// ⌘B is bold in rich text, so it stays there; plain fields have no use for it.
const isEditable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[contenteditable]:not([contenteditable="false"])'))

/** The shortcut's key, from the key's position when the layout types another letter there (Cyrillic, Greek). */
function shortcutKey(event: KeyboardEvent): string {
  const key = event.key.toLowerCase()
  if (key === 'k' || key === 'b' || key === ',') return key
  return event.code === 'KeyK' ? 'k' : event.code === 'KeyB' ? 'b' : event.code === 'Comma' ? ',' : key
}

/**
 * The signed-in app: the sidebar, the page, the queue beside it and the player along the bottom.
 * Below 768px the sidebar is a drawer and the player a small bar.
 *
 * Memoized, and it reads no playback state itself: the session changes many times a second while
 * something plays, and only the parts that show it (`ShellPlayer`, `ShellQueue`, `ShellNowPlaying`,
 * the sidebar's playing marker) render again for it.
 */
export const AppShell = memo(function AppShell({ user, playlists, likedCount, onPlayPlaylist, onPlayLiked, onLogout, renderSearch, renderSettings }: AppShellProps) {
  const { pathname } = useLocation()
  const frame = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Only the room the frame leaves the sidebar matters, so resizing the window renders when that changes.
  const [maxWidth, setMaxWidth] = useState(() => sidebarMaxWidth(window.innerWidth))
  // The open sidebar's width is kept as set; what shows is clamped to the room there is now.
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const width = readSidebarWidth()
    // Before the first layout: applied in an effect, the sidebar would first be laid out at the
    // default width and then animate to the saved one on every load.
    applySidebarWidth(clampSidebarWidth(width, window.innerWidth))
    return width
  })
  const sidebarWidth = Math.round(Math.min(Math.max(preferredWidth, SIDEBAR_MIN_WIDTH), maxWidth))
  // Off for a frame when the layout switches between drawer and sidebar, and while a drag sizes it.
  const [transitions, setTransitions] = useState(true)
  const [tracking, setTracking] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [settings, setSettings] = useState<{ open: boolean; section: SettingsSection }>({ open: false, section: 'playback' })
  const [queueOpen, setQueueOpen] = useState(false)
  const [nowPlaying, setNowPlaying] = useState<NowPlayingView>({ open: false, pane: 'art' })

  // One dialog at a time: each shortcut closes the others.
  const openSettings = useCallback((section: SettingsSection = 'playback') => {
    setDrawerOpen(false)
    setSearchOpen(false)
    setSettings({ open: true, section })
  }, [])
  const settingsController = useMemo(() => ({ openSettings }), [openSettings])

  const setSidebarCollapsed = useCallback((next: boolean) => {
    setCollapsed(next)
    writeSidebarCollapsed(next)
  }, [])
  const toggleSidebar = useCallback(() => {
    if (mobile) setDrawerOpen(open => !open)
    else setSidebarCollapsed(!collapsed)
  }, [mobile, collapsed, setSidebarCollapsed])
  // The latest toggle, for the shortcut's listener.
  const toggleShortcut = useRef(toggleSidebar)
  useEffect(() => { toggleShortcut.current = toggleSidebar })

  useScrollMemory(scroller)

  // Arriving on another page closes what covers it (the drawer, Now Playing), whatever led there.
  const [shownPath, setShownPath] = useState(pathname)
  if (shownPath !== pathname) {
    setShownPath(pathname)
    setDrawerOpen(false)
    setNowPlaying(now => (now.open ? { ...now, open: false } : now))
  }
  const currentPath = useRef(pathname)
  useEffect(() => { currentPath.current = pathname })

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
    const measure = () => setMaxWidth(sidebarMaxWidth(element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => { applySidebarWidth(sidebarWidth) }, [sidebarWidth])

  // Toasts and notices float above the player, whatever height it has now ("Playing on…" adds a strip).
  useLayoutEffect(() => {
    const element = bottom.current
    if (!element) return
    const root = document.documentElement
    const measure = () => root.style.setProperty('--player-height', `${element.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--player-height')
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Shift and Alt combinations belong to the browser (⌘⇧B shows the bookmarks bar).
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = shortcutKey(event)
      if (key !== 'k' && key !== ',' && !(key === 'b' && !isEditable(event.target))) return
      event.preventDefault()
      // Held down, the key repeats; the first press is the one that counts.
      if (event.repeat) return
      if (key === 'k') {
        setDrawerOpen(false)
        setSettings(current => (current.open ? { ...current, open: false } : current))
        setSearchOpen(open => !open)
      } else if (key === 'b') {
        toggleShortcut.current()
      } else {
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
    const openedOn = currentPath.current
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
        if (active && active !== document.body && !drawer()?.contains(active)) return
        // After a link was followed, focus goes to the new page rather than back to the button.
        if (currentPath.current !== openedOn) document.getElementById('main-content')?.focus({ preventScroll: true })
        else openerButton?.focus()
      })
    }
  }, [drawerShown])

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const onSidebarToggle = useCallback(() => (mobile ? setDrawerOpen(false) : setSidebarCollapsed(!collapsed)), [mobile, collapsed, setSidebarCollapsed])
  const onOpenSettings = useCallback(() => openSettings(), [openSettings])
  const closeQueue = useCallback(() => setQueueOpen(false), [])
  const onSearchOpenChange = useCallback((open: boolean) => setSearchOpen(open), [])
  const onSettingsOpenChange = useCallback((open: boolean) => setSettings(current => ({ ...current, open })), [])
  const onSettingsSectionChange = useCallback((section: SettingsSection) => setSettings(current => ({ ...current, section })), [])

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
            onClick={closeDrawer}
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
          onToggle={onSidebarToggle}
          onNavigate={closeDrawer}
          onOpenSettings={onOpenSettings}
          onPlayPlaylist={onPlayPlaylist}
          onPlayLiked={onPlayLiked}
          onLogout={onLogout}
        />
        {!mobile && (
          <SidebarResizeHandle
            width={sidebarWidth}
            maxWidth={maxWidth}
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
                // The only way to the navigation on a phone: a 44px touch target around the 32px button.
                className="absolute left-2 top-2 z-30 flex size-8 items-center justify-center rounded-md bg-background/70 text-foreground outline-none backdrop-blur-md after:absolute after:-inset-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
                {/* A page that fails shows a message in its place; the next page starts afresh. */}
                <ErrorBoundary resetKey={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </ScrollContainerContext>
            </main>

            <QueueDock open={queueOpen} onClose={closeQueue} />
          </div>

          <div ref={bottom} className="shrink-0">
            <ShellPlayer mobile={mobile} queueOpen={queueOpen} setQueueOpen={setQueueOpen} nowPlaying={nowPlaying} setNowPlaying={setNowPlaying} />
          </div>
        </div>

        <ShellNowPlaying nowPlaying={nowPlaying} setNowPlaying={setNowPlaying} />
        <ShellNotices />
      </div>
      {renderSearch({ open: searchOpen, onOpenChange: onSearchOpenChange })}
      {renderSettings({ open: settings.open, section: settings.section, onOpenChange: onSettingsOpenChange, onSectionChange: onSettingsSectionChange })}
    </SettingsDialogContext>
  )
})

/** The heart for the track playing now. */
function useCurrentLike() {
  const { state } = usePlayer()
  const library = useLibrary()
  const track = state.current?.track
  const liked = track?.liked ?? false
  const toggleLike = () => { if (track) library.setSaved({ type: 'track', id: track.id, title: track.title }, !liked) }
  return { liked, toggleLike }
}

type ShellPlayerProps = {
  mobile: boolean
  queueOpen: boolean
  setQueueOpen: Dispatch<SetStateAction<boolean>>
  nowPlaying: NowPlayingView
  setNowPlaying: Dispatch<SetStateAction<NowPlayingView>>
}

/** The player along the bottom: the full bar on a desktop, the small one on a phone. */
function ShellPlayer({ mobile, queueOpen, setQueueOpen, nowPlaying, setNowPlaying }: ShellPlayerProps) {
  const player = usePlayer()
  const { liked, toggleLike } = useCurrentLike()
  const openNowPlaying = () => setNowPlaying({ open: true, pane: 'art' })
  if (mobile) return <MiniPlayer player={player} onOpenNowPlaying={openNowPlaying} />
  return (
    <PlayerBar
      player={player}
      liked={liked}
      onToggleLike={toggleLike}
      queueOpen={queueOpen}
      onToggleQueue={() => setQueueOpen(open => !open)}
      lyricsOpen={nowPlaying.open && nowPlaying.pane === 'lyrics'}
      onToggleLyrics={() => setNowPlaying(now => (now.open && now.pane === 'lyrics' ? { open: false, pane: 'art' } : { open: true, pane: 'lyrics' }))}
      onOpenNowPlaying={openNowPlaying}
    />
  )
}

/**
 * The queue beside the page: docked from 1280px, floating over the page's edge below that,
 * where it animates out as it animated in.
 */
function QueueDock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = panel.current
    if (open || !element) return
    // Docked or hidden there is no exit animation to wait for.
    const animation = getComputedStyle(element).animationName
    if (animation && animation !== 'none') return
    const frame = requestAnimationFrame(() => setPresent(false))
    return () => cancelAnimationFrame(frame)
  }, [open])
  // Floating over the page (768 to 1279px), the queue is modal: the page dims and stops taking
  // presses, and a press on it or Escape closes the queue. Docked from 1280px the page stays live.
  useEffect(() => {
    if (!open) return
    const floating = window.matchMedia('(min-width: 768px) and (max-width: 1279.98px)')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && floating.matches && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])
  if (!present) return null
  return (
    <>
    <button
      type="button"
      // A pointer target only, as the drawer's: Escape and the queue's own Close button close it from the keyboard.
      aria-hidden
      tabIndex={-1}
      onClick={onClose}
      className={cn('absolute inset-0 z-10 hidden bg-black/30 transition-opacity duration-200 md:block xl:hidden', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
    />
    <aside
      ref={panel}
      aria-label="Queue"
      aria-hidden={!open || undefined}
      inert={!open}
      data-state={open ? 'open' : 'closed'}
      onAnimationEnd={event => { if (!open && event.target === event.currentTarget) setPresent(false) }}
      className="absolute inset-y-2 right-2 z-20 hidden w-[22rem] animate-enter overflow-hidden rounded-lg border bg-background shadow-lg data-[state=closed]:animate-exit md:block xl:static xl:z-auto xl:w-[21rem] xl:animate-none xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none xl:data-[state=closed]:animate-none"
    >
      <ShellQueue onClose={onClose} />
    </aside>
    </>
  )
}

/** Reads the session only while the queue shows. */
function ShellQueue({ onClose }: { onClose: () => void }) {
  return <QueuePanel player={usePlayer()} onClose={onClose} />
}

function ShellNowPlaying({ nowPlaying, setNowPlaying }: Pick<ShellPlayerProps, 'nowPlaying' | 'setNowPlaying'>) {
  const player = usePlayer()
  const { liked, toggleLike } = useCurrentLike()
  return (
    <NowPlaying
      player={player}
      open={nowPlaying.open}
      onOpenChange={open => setNowPlaying(now => ({ ...now, open }))}
      pane={nowPlaying.pane}
      onPaneChange={pane => setNowPlaying(now => ({ ...now, pane }))}
      liked={liked}
      onToggleLike={toggleLike}
    />
  )
}
