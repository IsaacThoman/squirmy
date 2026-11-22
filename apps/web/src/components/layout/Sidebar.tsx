import type { PlaylistSummary, TrackSummary, User } from '@squirmy/contracts'
import { Bookmark, ChevronsUpDown, Disc3, House, ListMusic, ListPlus, LogOut, MicVocal, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Shield, Upload, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { canUploadMusic } from '@/lib/catalog'
import { draggedTracks } from '@/lib/drag'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <svg aria-hidden viewBox="0 0 64 64" className="size-8 shrink-0">
        <rect width="64" height="64" rx="16" className="fill-accent" />
        <path d="M14 38c4-10 8-10 12 0s8 10 12 0 8-10 12 0" fill="none" strokeWidth="6" strokeLinecap="round" className="stroke-on-accent" />
      </svg>
      <span className="text-base font-bold tracking-[-0.035em]">Squirmy</span>
    </span>
  )
}

const linkClass = 'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors duration-150 hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:font-semibold aria-[current=page]:text-accent [&>svg]:size-4 [&>svg]:shrink-0'

type SidebarLinkProps = { to: string; icon: ReactNode; children: string; end?: boolean; collapsed: boolean; onNavigate?: () => void }

function SidebarLink({ to, icon, children, end, collapsed, onNavigate }: SidebarLinkProps) {
  return (
    <Tooltip label={collapsed ? children : null} side="right">
      <NavLink to={to} end={end} onClick={onNavigate} className={cn(linkClass, collapsed && 'justify-center px-0')}>
        {icon}<span className={collapsed ? 'sr-only' : undefined}>{children}</span>
      </NavLink>
    </Tooltip>
  )
}

type SidebarProps = {
  user: User
  playlists: PlaylistSummary[]
  /** "24 songs" under Liked Songs. */
  likedCount: string
  onLogout: () => void
}

type SidebarContentsProps = SidebarProps & {
  collapsed: boolean
  onNavigate?: () => void
  headerAction: ReactNode
  id?: string
  className?: string
}

function SidebarContents({ user, playlists, likedCount, onLogout, collapsed, onNavigate, headerAction, id, className }: SidebarContentsProps) {
  const library = useLibrary()
  const linkProps = { collapsed, onNavigate }

  return (
    <nav id={id} aria-label="Main" className={cn('flex h-full flex-col bg-sheet', className)}>
      <div className={cn('flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-1.5 px-3 pt-[env(safe-area-inset-top)] md:h-14 md:pt-0', collapsed && 'justify-center px-0')}>
        {!collapsed && (
          <NavLink to="/" aria-label="Squirmy home" onClick={onNavigate} className="mr-auto min-w-0 rounded-lg px-1">
            <Logo className="[&>svg]:size-7" />
          </NavLink>
        )}
        {headerAction}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-2.5 pb-3">
          <div className="space-y-0.5">
            <SidebarLink to="/" end icon={<House />} {...linkProps}>Home</SidebarLink>
            <SidebarLink to="/search" icon={<Search />} {...linkProps}>Search</SidebarLink>
          </div>

          <div className={cn('space-y-0.5', collapsed && 'border-t border-stroke pt-2.5')}>
            <h2 className={cn('px-2.5 pb-1 text-[11px] font-semibold text-quiet', collapsed && 'sr-only')}>Library</h2>
            <SidebarLink to="/library/albums" icon={<Disc3 />} {...linkProps}>Albums</SidebarLink>
            <SidebarLink to="/library/artists" icon={<MicVocal />} {...linkProps}>Artists</SidebarLink>
            <SidebarLink to="/library/songs" icon={<ListMusic />} {...linkProps}>Songs</SidebarLink>
            <SidebarLink to="/wantlist" icon={<Bookmark />} {...linkProps}>Wantlist</SidebarLink>
            {canUploadMusic(user) && <SidebarLink to="/imports" icon={<Upload />} {...linkProps}>Add music</SidebarLink>}
          </div>

          <div className={cn(collapsed && 'border-t border-stroke pt-2.5')}>
            <div className={cn('mb-0.5 flex items-center justify-between gap-1', collapsed && 'flex-col')}>
              {collapsed ? <SidebarLink to="/library/playlists" icon={<ListPlus />} {...linkProps}>Playlists</SidebarLink> : (
                <h2 className="min-w-0 flex-1">
                  <NavLink to="/library/playlists" onClick={onNavigate} className="block rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-quiet hover:text-foreground aria-[current=page]:text-accent">Playlists</NavLink>
                </h2>
              )}
              <IconButton
                label="New playlist"
                size="sm"
                className="rounded-lg"
                onClick={() => {
                  onNavigate?.()
                  library.newPlaylist()
                }}
              >
                <Plus />
              </IconButton>
            </div>
            <ul className="flex flex-col gap-0.5">
              <li>
                <PlaylistLink
                  to="/liked"
                  title="Liked Songs"
                  subtitle={likedCount}
                  art={<LikedCover className="size-8 rounded-md" />}
                  onDropTracks={tracks => tracks.filter(track => !track.liked).forEach(track => library.setLiked('track', track.id, true))}
                  {...linkProps}
                />
              </li>
              {playlists.map(playlist => (
                <li key={playlist.id}>
                  <PlaylistLink
                    to={`/playlist/${playlist.id}`}
                    title={playlist.name}
                    subtitle={plural(playlist.trackCount, 'song')}
                    art={<PlaylistCover artworks={playlist.artworks} className="size-8 rounded-md" />}
                    onDropTracks={playlist.ownerId === user.id ? tracks => library.addToPlaylist(playlist, tracks) : undefined}
                    {...linkProps}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </ScrollArea>

      <div className="shrink-0 space-y-0.5 border-t border-stroke px-2.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        <SidebarLink to="/settings" icon={<Settings />} {...linkProps}>Settings</SidebarLink>
        {user.role === 'admin' && <SidebarLink to="/admin" icon={<Shield />} {...linkProps}>Management</SidebarLink>}
        <AccountMenu user={user} onLogout={onLogout} compact={collapsed} onNavigate={onNavigate} className="mt-1 w-full" />
      </div>
    </nav>
  )
}

export function Sidebar({ collapsed, onToggle, ...props }: SidebarProps & { collapsed: boolean; onToggle: () => void }) {
  return (
    <SidebarContents
      {...props}
      id="app-sidebar"
      collapsed={collapsed}
      className={cn('shrink-0 border-r border-stroke', collapsed ? 'w-14' : 'w-[246px]')}
      headerAction={(
        <IconButton
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-controls="app-sidebar"
          aria-expanded={!collapsed}
          size="sm"
          className="rounded-lg"
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </IconButton>
      )}
    />
  )
}

export function MobileSidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 48rem)')
    const onResize = (event: MediaQueryListEvent) => { if (event.matches) setOpen(false) }
    desktop.addEventListener('change', onResize)
    return () => desktop.removeEventListener('change', onResize)
  }, [])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <IconButton label="Open navigation" tooltip={false} size="sm" className="rounded-lg md:hidden"><PanelLeftOpen /></IconButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/45 md:hidden" />
        <Dialog.Content aria-describedby={undefined} className="fixed inset-y-0 left-0 z-40 w-[min(82vw,19rem)] animate-enter border-r border-stroke shadow-float focus:outline-none md:hidden">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <SidebarContents
            {...props}
            collapsed={false}
            onNavigate={() => setOpen(false)}
            headerAction={(
              <Dialog.Close asChild>
                <IconButton label="Close navigation" tooltip={false} size="sm" className="rounded-lg"><X /></IconButton>
              </Dialog.Close>
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function AccountMenu({ user, onLogout, compact, onNavigate, className }: {
  user: User
  onLogout: () => void
  compact?: boolean
  onNavigate?: () => void
  className?: string
}) {
  const navigate = useNavigate()
  const name = user.displayName ?? user.username
  const go = (to: string) => {
    onNavigate?.()
    void navigate(to)
  }

  return (
    <DropdownMenu
      align={compact ? 'end' : 'start'}
      entries={[
        { kind: 'label', label: name },
        { label: 'Settings', icon: <Settings />, onSelect: () => go('/settings') },
        ...(canUploadMusic(user) ? [{ label: 'Add music', icon: <Upload />, onSelect: () => go('/imports') }] : []),
        ...(user.role === 'admin' ? [{ label: 'Management', icon: <Shield />, onSelect: () => go('/admin') }] : []),
        { kind: 'separator' },
        { label: 'Log out', icon: <LogOut />, onSelect: onLogout },
      ]}
      trigger={(
        <button
          type="button"
          aria-label={`Account, ${name}`}
          className={cn(
            'flex h-10 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-overlay data-[state=open]:bg-overlay',
            compact && 'size-9 justify-center px-0',
            className,
          )}
        >
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-selection text-xs font-bold text-accent">
            {name.slice(0, 1).toUpperCase()}
          </span>
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold leading-tight">{name}</span>
                <span className="block truncate text-[11px] leading-tight text-muted">{user.role === 'admin' ? 'Administrator' : 'Member'}</span>
              </span>
              <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-quiet" />
            </>
          )}
        </button>
      )}
    />
  )
}

type PlaylistLinkProps = {
  to: string
  title: string
  subtitle: string
  art: ReactNode
  collapsed: boolean
  onNavigate?: () => void
  onDropTracks?: (tracks: TrackSummary[]) => void
}

function PlaylistLink({ to, title, subtitle, art, collapsed, onNavigate, onDropTracks }: PlaylistLinkProps) {
  const [over, setOver] = useState(false)
  const accepts = (event: DragEvent) => Boolean(onDropTracks && draggedTracks(event))
  return (
    <Tooltip label={collapsed ? title : null} side="right">
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
          'flex items-center gap-2.5 rounded-lg p-1.5 transition-colors duration-150 hover:bg-overlay aria-[current=page]:bg-selection',
          collapsed && 'justify-center px-0',
          over && 'bg-selection ring-2 ring-accent',
        )}
      >
        {art}
        <span className={cn('min-w-0', collapsed && 'sr-only')}>
          <span className="block truncate text-[13px] font-medium leading-tight">{title}</span>
          <span className="block truncate text-[11px] text-muted">{subtitle}</span>
        </span>
      </NavLink>
    </Tooltip>
  )
}
