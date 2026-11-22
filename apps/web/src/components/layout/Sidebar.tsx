import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, House, Library, LogOut, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Settings, ShieldCheck, Upload, type LucideIcon } from 'lucide-react'
import { memo, useCallback, useMemo, useState, type DragEvent, type ReactNode } from 'react'
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
          'flex h-8 items-center overflow-hidden rounded-lg text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground',
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
          ? cn('fixed inset-y-0 left-0 z-40 w-[min(82vw,320px)] shadow-2xl', transitions && 'transition-transform duration-200 ease-out', !mobileOpen && '-translate-x-full')
          : cn('relative z-20', transitions && 'transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed ? 'w-[52px]' : 'w-(--sidebar-width)'),
      )}
    >
      <div className="flex items-center gap-1 p-2">
        <Tooltip label={collapsed ? 'Open sidebar' : null} side="right">
          {collapsed ? (
            <button type="button" onClick={onToggle} aria-label="Open sidebar" className="group/logo flex size-9 items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
              <LogoMark className="group-hover/logo:hidden" />
              <PanelLeftOpen aria-hidden className="hidden size-4 group-hover/logo:block" />
            </button>
          ) : (
            <Link to="/" onClick={onNavigate} aria-label="Squirmy home" className="flex size-9 items-center justify-center rounded-lg outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
              <LogoMark />
            </Link>
          )}
        </Tooltip>
        <span className={cn('min-w-0 flex-1 truncate whitespace-nowrap text-sm font-semibold', textTransition)}>Squirmy</span>
        {!collapsed && (
          <Tooltip label={mobile ? null : 'Close sidebar'} side="right">
            <button type="button" onClick={onToggle} aria-label="Close sidebar" className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <PanelLeftClose aria-hidden className="size-4" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* The navigation and the playlists share one scroll position; the header and the account stay put. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <nav aria-label="Main" className="space-y-0.5 px-2">
          {navItem('/', 'Home', House, { end: true })}
          {navItem('/search', 'Search', Search, { hint: mobile ? undefined : <Kbd>{modKey}K</Kbd> })}
          {navItem('/library', 'Library', Library)}
          {library.wantlistEnabled && navItem('/wantlist', 'Wantlist', Bookmark)}
          {canUploadMusic(user) && navItem('/imports', 'Add music', Upload)}
        </nav>

        {/* Stays mounted while folded, so it fades on the same timeline as the labels. */}
        <div aria-hidden={collapsed} inert={collapsed} className={cn('transition-opacity ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed && 'h-0 overflow-hidden', contentTransition)}>
          <div className="px-2 pb-4 pt-4">
            <div className="flex items-center px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Link to="/library?filter=playlists" onClick={onNavigate} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline">Playlists</Link>
              {/* In the drawer the tooltip would only take the first Escape. */}
              <Tooltip label={mobile ? null : 'New playlist'} side="right">
                <button type="button" onClick={() => library.newPlaylist()} aria-label="New playlist" className="-my-0.5 ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Plus aria-hidden className="size-3.5" />
                </button>
              </Tooltip>
            </div>
            <ul role="list" aria-label="Playlists" className="space-y-0.5">
              <li>
                <LikedRow detail={likedCount} playing={runningIn('liked', null)} entries={likedEntries} onNavigate={onNavigate} onDropTracks={likeTracks} />
              </li>
              {playlists.map(playlist => (
                <li key={playlist.id}>
                  <PlaylistItem
                    playlist={playlist}
                    playing={runningIn('playlist', playlist.id)}
                    owned={playlist.ownerId === user.id}
                    onNavigate={onNavigate}
                    onPlay={onPlayPlaylist}
                    onDropTracks={addToPlaylist}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* As tall as the player bar beside it, so their top edges run as one line. */}
      <div className={cn('border-t border-sidebar-border p-2', !mobile && 'flex h-18 shrink-0 items-center')}>
        <DropdownMenu
          side="top"
          align="start"
          contentClassName="w-56"
          entries={accountEntries}
          trigger={(
            <button type="button" aria-label={`Account, ${name}`} className="flex h-10 w-full items-center gap-2 overflow-hidden rounded-lg text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent">
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

const LikedRow = memo(function LikedRow({ detail, playing, entries, onNavigate, onDropTracks }: Pick<PlaylistRowProps, 'detail' | 'playing' | 'entries' | 'onNavigate' | 'onDropTracks'>) {
  return <PlaylistRow to="/liked" title="Liked Songs" detail={detail} art={<LikedCover className="size-6 rounded-[5px]" />} playing={playing} entries={entries} onNavigate={onNavigate} onDropTracks={onDropTracks} />
})

type PlaylistItemProps = {
  playlist: PlaylistSummary
  playing: boolean | null
  /** Songs can be dropped only on the user's own playlists. */
  owned: boolean
  onNavigate: () => void
  onPlay: (playlist: PlaylistSummary) => void
  onDropTracks: (playlist: PlaylistSummary, tracks: TrackSummary[]) => void
}

/** Memoized with stable props, so a long list of playlists renders again only where something changed. */
const PlaylistItem = memo(function PlaylistItem({ playlist, playing, owned, onNavigate, onPlay, onDropTracks }: PlaylistItemProps) {
  const entries = useMemo<MenuEntry[]>(() => [{ label: 'Play', icon: <Play />, onSelect: () => onPlay(playlist), disabled: playlist.trackCount === 0 }], [playlist, onPlay])
  return (
    <PlaylistRow
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      art={<PlaylistCover artworks={playlist.artworks} className="size-6 rounded-[5px]" />}
      playing={playing}
      entries={entries}
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
  onNavigate: () => void
  onDropTracks?: (tracks: TrackSummary[]) => void
}

function PlaylistRow({ to, title, detail, art, playing, entries, onNavigate, onDropTracks }: PlaylistRowProps) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => Boolean(onDropTracks && draggedTracks(event))
  return (
    <ContextMenu entries={entries}>
      <NavLink
        to={to}
        title={title}
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
          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground',
          over && 'bg-sidebar-accent ring-2 ring-primary',
        )}
      >
        {art}
        <span dir="auto" className="min-w-0 flex-1 truncate">{title}</span>
        {playing !== null
          ? <Equalizer playing={playing} className="h-3 shrink-0" />
          : detail && <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>}
      </NavLink>
    </ContextMenu>
  )
}
