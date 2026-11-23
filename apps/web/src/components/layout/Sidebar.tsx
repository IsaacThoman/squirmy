import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, House, Library, LogOut, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Settings, ShieldCheck, Upload, type LucideIcon } from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { Equalizer } from '@/components/music/Equalizer'
import { Kbd } from '@/components/ui/feedback'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Tooltip } from '@/components/ui/tooltip'
import { canUploadMusic } from '@/lib/catalog'
import { draggedTracks } from '@/lib/drag'
import { plural } from '@/lib/format'
import { modKey } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { usePlayer } from '@/player/player-context'
import { LogoMark } from './Logo'

type SidebarProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" beside Liked Songs. */
  likedCount: string
  /** Folded to a rail of icons. Never while it is a drawer. */
  collapsed: boolean
  /** A drawer over the page, as on phones. */
  mobile: boolean
  mobileOpen: boolean
  /** Off while the sidebar follows a drag or the layout changes, so nothing animates. */
  transitions?: boolean
  onToggle: () => void
  /** A link was followed: the drawer closes. */
  onNavigate: () => void
  onOpenSettings: () => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
  onPlayLiked: () => void
  onLogout: () => void
}

/** The collection playing now, if the sidebar lists it, and whether playback is running. */
type PlayingCollection = { type: 'playlist' | 'liked'; id: string | null; running: boolean }

/**
 * Navigation, the user's playlists and the account menu. On a desktop it folds to a rail of icons
 * and is as wide as the user drags it; on a phone it is a drawer. Songs dragged onto a playlist
 * are added to it.
 */
export function Sidebar(props: SidebarProps) {
  // The session changes many times while something plays; the sidebar only shows which of its
  // collections plays, so it renders again only when that changes.
  const { state } = usePlayer()
  const context = state.current ? state.context : null
  const type = context?.type === 'playlist' || context?.type === 'liked' ? context.type : null
  const id = context?.id ?? null
  const playing = useMemo(() => (type ? { type, id, running: state.playing } : null), [type, id, state.playing])
  return <SidebarView {...props} playing={playing} />
}

const SidebarView = memo(function SidebarView({
  user, playlists, likedCount, collapsed, mobile, mobileOpen, transitions = true, onToggle, onNavigate, onOpenSettings, onPlayPlaylist, onPlayLiked, onLogout, playing,
}: SidebarProps & { playing: PlayingCollection | null }) {
  const library = useLibrary()
  const navigate = useNavigate()
  const name = user.displayName ?? user.username
  const runningIn = (type: PlayingCollection['type'], id: string | null) => (playing?.type === type && playing.id === id ? playing.running : null)
  // Songs dropped on Liked Songs are saved to the library, with one toast for them all.
  const likeTracks = useCallback((tracks: TrackSummary[]) => {
    const saving = tracks.filter(track => !track.liked)
    if (!saving.length) return
    saving.forEach(track => library.setSaved({ type: 'track', id: track.id, title: track.title }, true, { quiet: true }))
    toast({ title: 'Saved to your library', description: saving.length === 1 ? saving[0].title : plural(saving.length, 'song') })
  }, [library])
  const addToPlaylist = useCallback((playlist: PlaylistSummary, tracks: TrackSummary[]) => library.addToPlaylist(playlist, tracks), [library])
  const likedEntries = useMemo<MenuEntry[]>(() => [{ label: 'Play', icon: <Play />, onSelect: onPlayLiked }], [onPlayLiked])

  // Labels fade out a little before the sidebar finishes folding, and in after it opens.
  const contentTransition = !transitions
    ? collapsed ? 'pointer-events-none opacity-0 duration-0' : 'opacity-100 duration-0'
    : collapsed ? 'pointer-events-none opacity-0 duration-100' : 'opacity-100 delay-100 duration-150'
  const textTransition = cn('transition-[opacity,transform] ease-[cubic-bezier(0.4,0,0.2,1)]', contentTransition, collapsed ? '-translate-x-1' : 'translate-x-0')

  const navItem = (to: string, label: string, Icon: LucideIcon, options: { end?: boolean; hint?: ReactNode } = {}) => (
    <Tooltip key={to} label={collapsed ? label : null} side="right">
      <NavLink
        to={to}
        end={options.end}
        onClick={onNavigate}
        aria-label={label}
        className={cn(
          'relative flex h-8 pointer-coarse:h-11 items-center overflow-hidden rounded-lg text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground',
          // The selected fill is close to the hover fill and to the sidebar itself, so the page you
          // are on also gets a bar and an icon in the action color, which stand 3:1 off it.
          'before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary before:opacity-0 aria-[current=page]:before:opacity-100 aria-[current=page]:[&_svg]:text-primary',
          // Square on the rail, centred under the logo.
          collapsed ? 'mx-0.5 w-8' : 'w-full',
        )}
      >
        <span className={cn('flex h-8 shrink-0 items-center justify-center', collapsed ? 'w-8' : 'w-9')}><Icon aria-hidden className="size-4" /></span>
        <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap pr-2', textTransition)}>{label}</span>
        {options.hint && <span className={cn('pr-2', textTransition)}>{options.hint}</span>}
      </NavLink>
    </Tooltip>
  )

  /*
   * Folding swaps the toggle for another button (the logo opens the rail again), and the one that
   * had focus leaves the page with it. When the toggle had focus, its replacement takes it, so a
   * keyboard user is not sent back to the top of the page.
   */
  const toggleRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    refocus.current = document.activeElement === event.currentTarget
    onToggle()
  }
  // The shell's ⌘B (Ctrl+B) toggles too. Pressed on the toggle, the key reaches it first, so its
  // replacement takes focus then as well. The shell folds it before the next frame, or not at all.
  const onToggleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'b' && event.code !== 'KeyB') return
    refocus.current = true
    requestAnimationFrame(() => { refocus.current = false })
  }
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    toggleRef.current?.focus()
  }, [collapsed])

  const accountEntries: MenuEntry[] = [
    { kind: 'label', label: `${name} · ${user.role === 'admin' ? 'Admin' : 'Member'}` },
    { label: 'Settings', icon: <Settings />, onSelect: onOpenSettings, shortcut: `${modKey},` },
    ...(user.role === 'admin' ? [{ label: 'Admin panel', icon: <ShieldCheck />, onSelect: () => { onNavigate(); void navigate('/admin') } }] : []),
    { kind: 'separator' },
    { label: 'Log out', icon: <LogOut />, onSelect: onLogout, danger: true },
  ]

  return (
    <aside
      aria-label="Sidebar"
      aria-hidden={mobile && !mobileOpen}
      inert={mobile && !mobileOpen}
      className={cn(
        'flex h-full shrink-0 select-none flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground motion-reduce:transition-none',
        mobile
          // The drawer reaches the screen's edges; its controls stay clear of the notch, the rounded corners and the home indicator.
          ? cn('fixed inset-y-0 left-0 z-40 w-[min(82vw,320px)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] shadow-2xl', transitions && 'transition-transform duration-200 ease-out', !mobileOpen && '-translate-x-full')
          : cn('relative z-20', transitions && 'transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed ? 'w-[52px]' : 'w-(--sidebar-width)'),
      )}
    >
      <div className="flex items-center gap-1 p-2">
        <Tooltip label={collapsed ? 'Open sidebar' : null} side="right">
          {collapsed ? (
            <button ref={toggleRef} type="button" onClick={toggle} onKeyDown={onToggleKeyDown} aria-label="Open sidebar" className="group/logo touch-target relative flex size-9 items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
              <LogoMark size={30} className="group-hover/logo:hidden" />
              <PanelLeftOpen aria-hidden className="hidden size-4 group-hover/logo:block" />
            </button>
          ) : (
            <Link to="/" onClick={onNavigate} aria-label="Squirmy home" className="touch-target relative flex size-9 items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
              <LogoMark size={30} />
            </Link>
          )}
        </Tooltip>
        <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap text-sm font-semibold', textTransition)}>Squirmy</span>
        {!collapsed && (
          <Tooltip label={mobile ? null : 'Close sidebar'} side="right">
            <button ref={toggleRef} type="button" onClick={toggle} onKeyDown={onToggleKeyDown} aria-label="Close sidebar" className="relative flex size-8 items-center justify-center rounded-md pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <PanelLeftClose aria-hidden className="size-4" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* The navigation and the playlists share one scroll position; the header and the account stay put. */}
      {/* Folded, a scrollbar would take a third of the rail; the wheel, a swipe and Tab still scroll it. */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden', collapsed && 'scrollbar-none')}>
        <nav aria-label="Main" className="space-y-0.5 px-2">
          {navItem('/', 'Home', House, { end: true })}
          {navItem('/search', 'Search', Search, { hint: mobile ? undefined : <Kbd>{modKey}K</Kbd> })}
          {navItem('/library', 'Library', Library)}
          {library.wantlistEnabled && navItem('/wantlist', 'Wantlist', Bookmark)}
          {canUploadMusic(user) && navItem('/imports', 'Add music', Upload)}
        </nav>

        {/*
          * Folded, Liked Songs and the playlists stay as a column of covers under a rule, each named
          * by a tooltip and to screen readers, so they are still one click away.
          */}
        <div className={cn('px-2', collapsed ? 'pb-2 pt-2' : 'pb-4 pt-4')}>
          {collapsed && <div aria-hidden className="mx-1.5 mb-2 border-t border-sidebar-border" />}
          {/* Stays mounted while folded, so it fades on the same timeline as the labels. */}
          <div aria-hidden={collapsed} inert={collapsed} className={cn('transition-opacity ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed && 'h-0 overflow-hidden', contentTransition)}>
            <div className="flex items-center px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Link to="/library?filter=playlists" onClick={onNavigate} className="rounded-sm underline-offset-2 outline-none pointer-coarse:flex pointer-coarse:h-11 pointer-coarse:items-center hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline">Playlists</Link>
              {/* In the drawer the tooltip would only take the first Escape. */}
              <Tooltip label={mobile ? null : 'New playlist'} side="right">
                <button type="button" onClick={() => library.newPlaylist()} aria-label="New playlist" className="relative -my-0.5 ml-auto flex size-6 items-center justify-center rounded-md pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Plus aria-hidden className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          </div>
          <ul role="list" aria-label="Playlists" className="space-y-0.5">
            <li>
              <LikedRow detail={likedCount} playing={runningIn('liked', null)} entries={likedEntries} collapsed={collapsed} labelClass={textTransition} onNavigate={onNavigate} onDropTracks={likeTracks} />
            </li>
            {playlists.map(playlist => (
              <li key={playlist.id}>
                <PlaylistItem
                  playlist={playlist}
                  playing={runningIn('playlist', playlist.id)}
                  owned={playlist.ownerId === user.id}
                  collapsed={collapsed}
                  labelClass={textTransition}
                  onNavigate={onNavigate}
                  onPlay={onPlayPlaylist}
                  onDropTracks={addToPlaylist}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* As tall as the player bar beside it, so their top edges run as one line. */}
      <div className={cn('border-t border-sidebar-border p-2', !mobile && 'flex h-18 pointer-coarse:h-[5.75rem] shrink-0 items-center')}>
        <DropdownMenu
          side="top"
          align="start"
          contentClassName="w-56"
          entries={accountEntries}
          trigger={(
            <button type="button" aria-label={`Account, ${name}`} className="flex h-10 w-full items-center gap-2 overflow-hidden rounded-lg text-left outline-none pointer-coarse:h-11 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent">
              <span className="flex size-9 shrink-0 items-center justify-center">
                <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{initial(name)}</span>
              </span>
              <span className={cn('min-w-0 flex-1 whitespace-nowrap pr-2', textTransition)}>
                <span dir="auto" className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">@{user.username}</span>
              </span>
            </button>
          )}
        />
      </div>
    </aside>
  )
})

/** The first character as a reader sees it, so an emoji or accented letter stays whole. */
function initial(name: string): string {
  const first = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)[Symbol.iterator]().next().value?.segment
    : Array.from(name)[0]
  return (first ?? '?').toUpperCase()
}

type LikedRowProps = Pick<PlaylistRowProps, 'detail' | 'playing' | 'entries' | 'collapsed' | 'labelClass' | 'onNavigate' | 'onDropTracks'>

const LikedRow = memo(function LikedRow({ detail, playing, entries, collapsed, labelClass, onNavigate, onDropTracks }: LikedRowProps) {
  return <PlaylistRow to="/liked" title="Liked Songs" detail={detail} art={<LikedCover className="size-6 rounded-[5px]" />} playing={playing} entries={entries} collapsed={collapsed} labelClass={labelClass} onNavigate={onNavigate} onDropTracks={onDropTracks} />
})

type PlaylistItemProps = {
  playlist: PlaylistSummary
  playing: boolean | null
  /** Songs can be dropped only on the user's own playlists. */
  owned: boolean
  collapsed: boolean
  labelClass: string
  onNavigate: () => void
  onPlay: (playlist: PlaylistSummary) => void
  onDropTracks: (playlist: PlaylistSummary, tracks: TrackSummary[]) => void
}

/** Memoized with stable props, so a long list of playlists renders again only where something changed. */
const PlaylistItem = memo(function PlaylistItem({ playlist, playing, owned, collapsed, labelClass, onNavigate, onPlay, onDropTracks }: PlaylistItemProps) {
  const entries = useMemo<MenuEntry[]>(() => [{ label: 'Play', icon: <Play />, onSelect: () => onPlay(playlist), disabled: playlist.trackCount === 0 }], [playlist, onPlay])
  return (
    <PlaylistRow
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      art={<PlaylistCover artworks={playlist.artworks} className="size-6 rounded-[5px]" />}
      playing={playing}
      entries={entries}
      collapsed={collapsed}
      labelClass={labelClass}
      onNavigate={onNavigate}
      onDropTracks={owned ? tracks => onDropTracks(playlist, tracks) : undefined}
    />
  )
})

type PlaylistRowProps = {
  to: string
  title: string
  detail?: string
  art: ReactNode
  /** Whether it is the collection playing now, and if so whether playback is running. */
  playing: boolean | null
  entries: MenuEntry[]
  /** Folded to a rail: the cover alone, named by a tooltip. */
  collapsed: boolean
  /** How the name and the count fade as the sidebar folds, as the navigation's labels do. */
  labelClass: string
  onNavigate: () => void
  onDropTracks?: (tracks: TrackSummary[]) => void
}

function PlaylistRow({ to, title, detail, art, playing, entries, collapsed, labelClass, onNavigate, onDropTracks }: PlaylistRowProps) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => Boolean(onDropTracks && draggedTracks(event))
  const link = (
    <NavLink
      to={to}
      // Open, a name cut short shows whole on hover; folded, the tooltip says it.
      title={collapsed ? undefined : title}
      onClick={onNavigate}
      onDragOver={event => {
        if (!accepts(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      // Moving onto the row's own cover or title is not leaving it.
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false) }}
      onDrop={event => {
        const drag = draggedTracks(event)
        setOver(false)
        if (!onDropTracks || !drag) return
        event.preventDefault()
        onDropTracks(drag.tracks)
      }}
      className={cn(
        'flex items-center gap-2 overflow-hidden rounded-lg text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground',
        // Folded: a square under the navigation's icons, the cover centred in it.
        // A folded rail can be on a touch tablet: the cover's hit area reaches 44 px.
        collapsed ? 'touch-target relative mx-0.5 w-8 p-1' : 'px-2 py-1.5 pointer-coarse:min-h-11',
        over && 'bg-sidebar-accent ring-2 ring-primary',
      )}
    >
      <span className="flex shrink-0">{art}</span>
      <span dir="auto" className={cn('min-w-0 flex-1 truncate whitespace-nowrap', labelClass)}>{title}</span>
      {playing !== null
        ? <Equalizer playing={playing} className={cn('h-3 shrink-0', labelClass)} />
        : detail && <span className={cn('shrink-0 whitespace-nowrap text-xs text-muted-foreground', labelClass)}>{detail}</span>}
    </NavLink>
  )
  // Folded, the tooltip names the cover. Its trigger is the link and the menu's is the box around it: each takes its props from an element of its own.
  return (
    <ContextMenu entries={entries}>
      <div><Tooltip label={collapsed ? title : null} side="right">{link}</Tooltip></div>
    </ContextMenu>
  )
}
