import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, Disc3, House, LogOut, MicVocal, Music2, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Settings, ShieldCheck, Upload, type LucideIcon } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { Equalizer } from '@/components/music/Equalizer'
import { Kbd } from '@/components/ui/feedback'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Tooltip } from '@/components/ui/tooltip'
import { canUploadMusic } from '@/lib/catalog'
import { draggedTracks } from '@/lib/drag'
import { modKey } from '@/lib/platform'
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

/**
 * Navigation, the user's playlists and the account menu. On a desktop it folds to a rail of icons
 * and is as wide as the user drags it; on a phone it is a drawer. Songs dragged onto a playlist
 * are added to it.
 */
export function Sidebar({ user, playlists, likedCount, collapsed, mobile, mobileOpen, transitions = true, onToggle, onNavigate, onOpenSettings, onPlayPlaylist, onPlayLiked, onLogout }: SidebarProps) {
  const library = useLibrary()
  const navigate = useNavigate()
  const { state } = usePlayer()
  const name = user.displayName ?? user.username
  const playingFrom = (type: 'playlist' | 'liked', id: string | null) => state.current !== null && state.context?.type === type && state.context.id === id

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
          'flex h-8 items-center overflow-hidden rounded-lg text-sm text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground',
          collapsed ? 'w-9' : 'w-full',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center"><Icon aria-hidden className="size-4" /></span>
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
          : cn('relative z-20 will-change-[width]', transitions && 'transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed ? 'w-[52px]' : 'w-(--sidebar-width)'),
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
            <button type="button" onClick={onToggle} aria-label="Close sidebar" className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
          {navItem('/library/albums', 'Albums', Disc3)}
          {navItem('/library/artists', 'Artists', MicVocal)}
          {navItem('/library/songs', 'Songs', Music2)}
          {navItem('/wantlist', 'Wantlist', Bookmark)}
          {canUploadMusic(user) && navItem('/imports', 'Add music', Upload)}
        </nav>

        {/* Stays mounted while folded, so it fades on the same timeline as the labels. */}
        <div aria-hidden={collapsed} inert={collapsed} className={cn('transition-opacity ease-[cubic-bezier(0.4,0,0.2,1)]', collapsed && 'h-0 overflow-hidden', contentTransition)}>
          <div className="px-2 pb-4 pt-4">
            <div className="flex items-center px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <Link to="/library/playlists" onClick={onNavigate} className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline">Playlists</Link>
              <Tooltip label="New playlist" side="right">
                <button type="button" onClick={() => library.newPlaylist()} aria-label="New playlist" className="-my-0.5 ml-auto flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Plus aria-hidden className="size-3.5" />
                </button>
              </Tooltip>
            </div>
            <ul role="list" aria-label="Playlists" className="space-y-0.5">
              <li>
                <PlaylistRow
                  to="/liked"
                  title="Liked Songs"
                  detail={likedCount}
                  art={<LikedCover className="size-6 rounded-[5px]" />}
                  playing={playingFrom('liked', null) ? state.playing : null}
                  entries={[{ label: 'Play', icon: <Play />, onSelect: onPlayLiked }]}
                  onNavigate={onNavigate}
                  onDropTracks={tracks => tracks.filter(track => !track.liked).forEach(track => library.setLiked('track', track.id, true))}
                />
              </li>
              {playlists.map(playlist => (
                <li key={playlist.id}>
                  <PlaylistRow
                    to={`/playlist/${playlist.id}`}
                    title={playlist.name}
                    art={<PlaylistCover artworks={playlist.artworks} className="size-6 rounded-[5px]" />}
                    playing={playingFrom('playlist', playlist.id) ? state.playing : null}
                    entries={[{ label: 'Play', icon: <Play />, onSelect: () => onPlayPlaylist(playlist), disabled: playlist.trackCount === 0 }]}
                    onNavigate={onNavigate}
                    onDropTracks={playlist.ownerId === user.id ? tracks => library.addToPlaylist(playlist, tracks) : undefined}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="border-t border-sidebar-border p-2">
        <DropdownMenu
          side="top"
          align="start"
          contentClassName="w-56"
          entries={accountEntries}
          trigger={(
            <button type="button" aria-label={`Account, ${name}`} className="flex h-10 w-full items-center gap-2 overflow-hidden rounded-lg text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent">
              <span className="flex size-9 shrink-0 items-center justify-center">
                <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{name.slice(0, 1).toUpperCase()}</span>
              </span>
              <span className={cn('min-w-0 flex-1 whitespace-nowrap pr-2', textTransition)}>
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">@{user.username}</span>
              </span>
            </button>
          )}
        />
      </div>
    </aside>
  )
}

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
        onDragLeave={() => setOver(false)}
        onDrop={event => {
          const drag = draggedTracks(event)
          setOver(false)
          if (!onDropTracks || !drag) return
          event.preventDefault()
          onDropTracks(drag.tracks)
        }}
        className={cn(
          'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground',
          over && 'bg-sidebar-accent ring-2 ring-primary',
        )}
      >
        {art}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {playing !== null
          ? <Equalizer playing={playing} className="h-3 shrink-0" />
          : detail && <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>}
      </NavLink>
    </ContextMenu>
  )
}
