import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, Disc3, House, ListMusic, MicVocal, Music2, PanelLeftClose, PanelLeftOpen, Plus, Search, Upload, X } from 'lucide-react'
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

type SidebarProps = {
  user: User
  playlists: PlaylistSummary[]
  likedCount: string
  compact?: boolean
  onToggle?: () => void
  onDismiss?: () => void
  onOpenSettings: (trigger: HTMLButtonElement | null) => void
  onLogout: () => void
}

export function Sidebar({ user, playlists, likedCount, compact = false, onToggle, onDismiss, onOpenSettings, onLogout }: SidebarProps) {
  const library = useLibrary()
  const links = [
    { items: [
      { to: '/', label: 'Home', icon: House },
      { to: '/search', label: 'Search', icon: Search },
    ] },
    { title: 'Library', items: [
      { to: '/library/albums', label: 'Albums', icon: Disc3 },
      { to: '/library/artists', label: 'Artists', icon: MicVocal },
      { to: '/library/songs', label: 'Songs', icon: Music2 },
      { to: '/wantlist', label: 'Wantlist', icon: Bookmark },
      ...(canUploadMusic(user) ? [{ to: '/imports', label: 'Add music', icon: Upload }] : []),
    ] },
  ]
  const toggleLabel = compact ? 'Expand sidebar' : 'Collapse sidebar'
  const toggle = onToggle && (
    <IconButton label={toggleLabel} size="sm" aria-expanded={!compact} onClick={onToggle}>
      {compact ? <PanelLeftOpen /> : <PanelLeftClose />}
    </IconButton>
  )
  return (
    <aside className={cn('flex h-full min-h-0 flex-col bg-sheet', compact ? 'w-16' : 'w-full md:w-56')}>
      <div className={cn('flex shrink-0 items-center gap-2 px-4 py-3', compact && 'flex-col px-0')}>
        <NavLink to="/" onClick={onDismiss} aria-label="Squirmy home" className="min-w-0 flex-1 rounded-lg"><Logo className={compact ? '[&>span:last-child]:hidden' : undefined} /></NavLink>
        {toggle}
        {onDismiss && <IconButton label="Close navigation" tooltip={false} size="sm" onClick={onDismiss}><X /></IconButton>}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Main" className="px-2.5 pb-3">
          {links.map(({ title, items }) => (
            <div key={items[0].to} className={cn('flex flex-col gap-0.5', title && 'mt-3 border-t border-stroke pt-2')}>
              {title && !compact && <p className="px-3 py-1 text-xs font-semibold text-muted">{title}</p>}
              {items.map(({ to, label, icon: Icon }) => (
                <Tooltip key={to} label={compact ? label : null} side="right">
                  <NavLink
                    to={to}
                    end={to === '/'}
                    onClick={onDismiss}
                    className={cn('flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:font-semibold aria-[current=page]:text-accent', compact && 'justify-center px-0')}
                  >
                    <Icon aria-hidden className="size-[18px] shrink-0" /><span className={compact ? 'sr-only' : 'truncate'}>{label}</span>
                  </NavLink>
                </Tooltip>
              ))}
            </div>
          ))}

          <div className={cn('mt-3 flex items-center justify-between gap-1 border-t border-stroke pt-2 pr-1 pl-3', compact && 'flex-col px-0')}>
            <Tooltip label={compact ? 'Playlists' : null} side="right">
              <NavLink
                to="/library/playlists"
                onClick={onDismiss}
                className={cn('text-xs font-semibold text-muted hover:text-foreground aria-[current=page]:text-accent', compact && 'grid size-9 place-items-center rounded-lg hover:bg-overlay aria-[current=page]:bg-selection')}
              >
                {compact && <ListMusic aria-hidden className="size-[18px]" />}
                <span className={compact ? 'sr-only' : undefined}>Playlists</span>
              </NavLink>
            </Tooltip>
            <IconButton label="New playlist" size="sm" onClick={() => { onDismiss?.(); library.newPlaylist() }}><Plus /></IconButton>
          </div>

          <ul className="flex flex-col gap-0.5 pt-1">
            <li>
              <PlaylistLink
                to="/liked"
                title="Liked Songs"
                subtitle={likedCount}
                art={<LikedCover className="size-8 rounded-md" />}
                compact={compact}
                onNavigate={onDismiss}
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
                  compact={compact}
                  onNavigate={onDismiss}
                  onDropTracks={playlist.ownerId === user.id ? tracks => library.addToPlaylist(playlist, tracks) : undefined}
                />
              </li>
            ))}
          </ul>
        </nav>
      </ScrollArea>

      <div className="shrink-0 border-t border-stroke p-2.5">
        <AccountMenu user={user} compact={compact} onOpenSettings={onOpenSettings} onNavigate={onDismiss} onLogout={onLogout} />
      </div>
    </aside>
  )
}

type PlaylistLinkProps = { to: string; title: string; subtitle: string; art: ReactNode; compact: boolean; onNavigate?: () => void; onDropTracks?: (tracks: TrackSummary[]) => void }

function PlaylistLink({ to, title, subtitle, art, compact, onNavigate, onDropTracks }: PlaylistLinkProps) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => Boolean(onDropTracks && draggedTracks(event))
  return (
    <Tooltip label={compact ? title : null} side="right">
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
        className={cn(
          'flex items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-overlay aria-[current=page]:bg-selection',
          compact && 'justify-center',
          over && 'bg-selection ring-2 ring-accent',
        )}
      >
        {art}
        <span className={cn('min-w-0', compact && 'sr-only')}>
          <span className="block truncate text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        </span>
      </NavLink>
    </Tooltip>
  )
}
