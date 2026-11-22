import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, Disc3, House, LibraryBig, ListMusic, MicVocal, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Shield, Upload } from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { NavLink } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { canUploadMusic } from '@/lib/catalog'
import { draggedTracks } from '@/lib/drag'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { AccountMenu } from './AccountMenu'

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <svg aria-hidden viewBox="0 0 64 64" className="size-8 shrink-0">
        <rect width="64" height="64" rx="16" className="fill-accent" />
        <path d="M14 38c4-10 8-10 12 0s8 10 12 0 8-10 12 0" fill="none" strokeWidth="6" strokeLinecap="round" className="stroke-on-accent" />
      </svg>
      <span className="text-lg font-extrabold tracking-[-0.04em]">Squirmy</span>
    </span>
  )
}

function SidebarLink({ to, icon, children, end, onNavigate }: { to: string; icon: ReactNode; children: string; end?: boolean; onNavigate?: () => void }) {
  return (
    <Tooltip label={children} side="right">
      <NavLink to={to} end={end} onClick={onNavigate} className="sidebar-link">
        {icon}<span className="sidebar-label">{children}</span>
      </NavLink>
    </Tooltip>
  )
}

export type SidebarProps = {
  user: User
  playlists: PlaylistSummary[]
  likedCount: string
}

export function Sidebar({ user, playlists, likedCount, collapsed, onCollapse, onNavigate, onLogout, closeButton }: SidebarProps & {
  collapsed?: boolean
  onCollapse?: () => void
  onNavigate?: () => void
  onLogout?: () => void
  closeButton?: ReactNode
}) {
  const library = useLibrary()
  return (
    <nav id={onCollapse ? 'desktop-sidebar' : undefined} aria-label="Main" className="workspace-sidebar" data-collapsed={collapsed || undefined}>
      <div className="sidebar-brand flex items-center justify-between gap-2 px-3 py-3.5">
        <NavLink to="/" aria-label="Squirmy home" onClick={onNavigate} className="sidebar-logo min-w-0 rounded-md"><Logo className="sidebar-wordmark" /></NavLink>
        {onCollapse && (
          <IconButton
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="desktop-sidebar"
            size="sm"
            onClick={onCollapse}
            className="sidebar-collapse rounded-lg"
          >{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</IconButton>
        )}
        {closeButton}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-2.5 pb-3">
          <div className="flex flex-col gap-0.5">
            <SidebarLink to="/" end icon={<House />} onNavigate={onNavigate}>Home</SidebarLink>
            <SidebarLink to="/search" icon={<Search />} onNavigate={onNavigate}>Search</SidebarLink>
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="sidebar-label sidebar-caption">Library</p>
            <SidebarLink to="/library/albums" icon={<Disc3 />} onNavigate={onNavigate}>Albums</SidebarLink>
            <SidebarLink to="/library/artists" icon={<MicVocal />} onNavigate={onNavigate}>Artists</SidebarLink>
            <SidebarLink to="/library/songs" icon={<ListMusic />} onNavigate={onNavigate}>Songs</SidebarLink>
            <SidebarLink to="/wantlist" icon={<Bookmark />} onNavigate={onNavigate}>Wantlist</SidebarLink>
            {canUploadMusic(user) && <SidebarLink to="/imports" icon={<Upload />} onNavigate={onNavigate}>Add music</SidebarLink>}
          </div>

          <div>
            <div className="sidebar-playlist-header flex items-center justify-between">
              <Tooltip label="All playlists" side="right">
                <NavLink to="/library/playlists" aria-label="All playlists" onClick={onNavigate} className="sidebar-caption sidebar-playlists-link flex min-h-8 items-center gap-2 rounded-md hover:text-foreground aria-[current=page]:text-accent">
                  <LibraryBig aria-hidden className="sidebar-playlists-icon size-4" />
                  <span className="sidebar-label">Playlists</span>
                </NavLink>
              </Tooltip>
              <IconButton label="New playlist" size="sm" className="rounded-lg" onClick={() => { onNavigate?.(); library.newPlaylist() }}><Plus /></IconButton>
            </div>
            <ul className="mt-1 flex flex-col gap-0.5">
              <li>
                <PlaylistLink
                  to="/liked"
                  title="Liked Songs"
                  subtitle={likedCount}
                  art={<LikedCover className="size-8 rounded-md" />}
                  onNavigate={onNavigate}
                  onDropTracks={tracks => tracks.filter(track => !track.liked).forEach(track => library.setLiked('track', track.id, true))}
                />
              </li>
              {playlists.map(playlist => (
                <li key={playlist.id}>
                  <PlaylistLink
                    to={`/playlist/${playlist.id}`}
                    title={playlist.name}
                    subtitle={plural(playlist.trackCount, 'song')}
                    art={<PlaylistCover artworks={playlist.artworks} className="size-8 rounded-md" />}
                    onNavigate={onNavigate}
                    onDropTracks={playlist.ownerId === user.id ? tracks => library.addToPlaylist(playlist, tracks) : undefined}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </ScrollArea>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-stroke px-2.5 py-2">
        <SidebarLink to="/settings" icon={<Settings />} onNavigate={onNavigate}>Settings</SidebarLink>
        {user.role === 'admin' && <SidebarLink to="/admin" icon={<Shield />} onNavigate={onNavigate}>Admin</SidebarLink>}
        {onLogout && <AccountMenu user={user} onLogout={onLogout} inSidebar />}
      </div>
    </nav>
  )
}

type PlaylistLinkProps = { to: string; title: string; subtitle: string; art: ReactNode; onNavigate?: () => void; onDropTracks?: (tracks: TrackSummary[]) => void }

function PlaylistLink({ to, title, subtitle, art, onNavigate, onDropTracks }: PlaylistLinkProps) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => Boolean(onDropTracks && draggedTracks(event))
  return (
    <Tooltip label={title} side="right">
      <NavLink
        to={to}
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
        className={cn('sidebar-collection', over && 'bg-selection ring-2 ring-inset ring-accent')}
      >
        {art}
        <span className="sidebar-label min-w-0">
          <span className="block truncate text-[13px] font-semibold">{title}</span>
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        </span>
      </NavLink>
    </Tooltip>
  )
}
