import type { PlaylistSummary, User } from '@squirmy/contracts'
import { Bookmark, Disc3, House, ListMusic, MicVocal, Plus, Search, Shield } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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

const linkClass = 'flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-semibold text-muted transition-colors duration-150 hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:text-accent max-lg:justify-center max-lg:px-0 [&>svg]:size-5 [&>svg]:shrink-0'

function SidebarLink({ to, icon, children, end }: { to: string; icon: ReactNode; children: string; end?: boolean }) {
  return (
    <Tooltip label={children} side="right">
      <NavLink to={to} end={end} className={linkClass}>
        {icon}<span className="max-lg:sr-only">{children}</span>
      </NavLink>
    </Tooltip>
  )
}

type SidebarProps = {
  user: User
  playlists: PlaylistSummary[]
  likedCount: number
  onCreatePlaylist: () => void
}

/** Full width from 1024px; icons only between 768 and 1024. */
export function Sidebar({ user, playlists, likedCount, onCreatePlaylist }: SidebarProps) {
  return (
    <nav aria-label="Main" className="flex h-full w-[4.75rem] shrink-0 flex-col border-r border-stroke bg-sheet pb-(--player-height) lg:w-64">
      <div className="flex h-16 items-center px-5 max-lg:justify-center max-lg:px-0">
        <NavLink to="/" aria-label="Squirmy home" className="rounded-lg"><Logo className="max-lg:[&>span:last-child]:hidden" /></NavLink>
      </div>
      <div className="flex flex-col gap-0.5 px-3">
        <SidebarLink to="/" end icon={<House />}>Home</SidebarLink>
        <SidebarLink to="/search" icon={<Search />}>Search</SidebarLink>
      </div>

      <p className="mt-6 px-6 pb-1.5 text-xs font-bold uppercase tracking-[0.1em] text-quiet max-lg:hidden">Library</p>
      <div className="flex flex-col gap-0.5 px-3 max-lg:mt-4 max-lg:border-t max-lg:border-stroke max-lg:pt-4">
        <SidebarLink to="/library/albums" icon={<Disc3 />}>Albums</SidebarLink>
        <SidebarLink to="/library/artists" icon={<MicVocal />}>Artists</SidebarLink>
        <SidebarLink to="/library/songs" icon={<ListMusic />}>Songs</SidebarLink>
        <SidebarLink to="/wantlist" icon={<Bookmark />}>Wantlist</SidebarLink>
      </div>

      <div className="mt-6 flex items-center justify-between pl-6 pr-3 max-lg:mt-4 max-lg:justify-center max-lg:border-t max-lg:border-stroke max-lg:px-0 max-lg:pt-4">
        <p className="text-xs font-bold uppercase tracking-[0.1em] text-quiet max-lg:hidden">Playlists</p>
        <IconButton label="New playlist" size="sm" onClick={onCreatePlaylist}><Plus /></IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 px-3 py-1.5">
          <li>
            <PlaylistLink to="/liked" title="Liked Songs" subtitle={`${likedCount} songs`} art={<LikedCover className="size-10 rounded-lg" />} />
          </li>
          {playlists.map(playlist => (
            <li key={playlist.id}>
              <PlaylistLink
                to={`/playlist/${playlist.id}`}
                title={playlist.name}
                subtitle={`Playlist · ${playlist.trackCount} songs`}
                art={<PlaylistCover artworks={playlist.artworks} className="size-10 rounded-lg" />}
              />
            </li>
          ))}
        </ul>
      </ScrollArea>

      {user.role === 'admin' && (
        <div className="border-t border-stroke px-3 pt-3">
          <SidebarLink to="/admin" icon={<Shield />}>Admin</SidebarLink>
        </div>
      )}
    </nav>
  )
}

function PlaylistLink({ to, title, subtitle, art }: { to: string; title: string; subtitle: string; art: ReactNode }) {
  return (
    <Tooltip label={title} side="right">
      <NavLink to={to} className="flex items-center gap-3 rounded-xl p-1.5 transition-colors duration-150 hover:bg-overlay aria-[current=page]:bg-selection max-lg:justify-center">
        {art}
        <span className="min-w-0 max-lg:sr-only">
          <span className="block truncate text-sm font-semibold">{title}</span>
          <span className="block truncate text-xs text-muted">{subtitle}</span>
        </span>
      </NavLink>
    </Tooltip>
  )
}
