import type { AlbumSummary, ArtistSummary, PlaylistSummary } from '@squirmy/contracts'
import { BookmarkCheck, BookmarkPlus, CloudDownload, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Tooltip } from '@/components/ui/tooltip'
import { albumTypeLabel, isUnowned } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useOnDemand } from '@/player/on-demand-context'
import { PlaylistCover } from './CollectionArt'
import { Cover } from './Cover'

type CardProps = {
  to: string
  title: string
  subtitle: ReactNode
  art: ReactNode
  onPlay?: () => void
  /** For music you do not have: a bookmark that adds it to the Wantlist, shown while wanted. */
  want?: { wanted: boolean; onChange: (wanted: boolean) => void }
  dimmed?: boolean
  badge?: ReactNode
  centered?: boolean
}

/** Artwork, a title and a subtitle, linking to a page. A play button rises on hover. */
function Card({ to, title, subtitle, art, onPlay, want, dimmed, badge, centered }: CardProps) {
  return (
    <div className={cn('group/card relative flex min-w-0 flex-col rounded-2xl p-2 -m-2 transition-colors duration-150 hover:bg-overlay focus-within:bg-overlay', centered && 'items-center text-center')}>
      <div className="relative w-full">
        {art}
        {badge && <div className="absolute left-2 top-2">{badge}</div>}
        {onPlay && (
          <button
            type="button"
            aria-label={`Play ${title}`}
            onClick={onPlay}
            className="absolute bottom-2 right-2 z-10 flex size-11 translate-y-2 items-center justify-center rounded-full bg-accent text-on-accent opacity-0 shadow-cover transition duration-150 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100"
          >
            <Play className="size-5 translate-x-px" fill="currentColor" />
          </button>
        )}
        {want && !onPlay && (
          <button
            type="button"
            aria-label={want.wanted ? `Remove ${title} from Wantlist` : `Add ${title} to Wantlist`}
            aria-pressed={want.wanted}
            onClick={() => want.onChange(!want.wanted)}
            className={cn(
              'absolute bottom-2 right-2 z-10 flex size-10 items-center justify-center rounded-full bg-sheet text-accent shadow-cover transition duration-150 hover:scale-105',
              !want.wanted && 'translate-y-2 opacity-0 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100',
            )}
          >
            {want.wanted ? <BookmarkCheck className="size-5" /> : <BookmarkPlus className="size-5" />}
          </button>
        )}
      </div>
      <Link to={to} title={title} className={cn('mt-2.5 truncate text-sm font-semibold after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none', dimmed && 'text-quiet', 'w-full')}>
        {title}
      </Link>
      <div className={cn('mt-0.5 w-full truncate text-[13px] text-muted', dimmed && 'text-quiet')}>{subtitle}</div>
    </div>
  )
}

type AlbumCardProps = {
  album: AlbumSummary
  onPlay?: () => void
  /** Offered on albums you do not have. */
  wanted?: boolean
  onWant?: (wanted: boolean) => void
  /** What the line under the title says. Artist pages show the year instead of the artist. */
  subtitle?: 'artist' | 'year'
}

export function AlbumCard({ album, onPlay, wanted = false, onWant, subtitle = 'artist' }: AlbumCardProps) {
  const { canRequest } = useOnDemand()
  const unowned = isUnowned(album)
  const partial = album.availability === 'partial'
  // On demand only for people who may fetch music; gray for everyone else.
  const onDemand = album.availability === 'on_demand' && canRequest
  const dimmed = album.availability === 'none' || (album.availability === 'on_demand' && !canRequest)
  return (
    <Card
      to={`/album/${album.id}`}
      title={album.title}
      subtitle={subtitle === 'year' ? [album.year, albumTypeLabel(album.type)].filter(Boolean).join(' · ') : album.artistCredit}
      art={<Cover artwork={album.artwork} dimmed={dimmed} className={cn(onDemand && 'opacity-80')} />}
      onPlay={unowned ? undefined : onPlay}
      want={unowned && onWant ? { wanted, onChange: onWant } : undefined}
      dimmed={dimmed}
      badge={onDemand
        ? <Tooltip label="Plays on demand"><span className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md"><CloudDownload aria-label="Plays on demand" className="size-4" /></span></Tooltip>
        : partial ? <span className="rounded-full bg-black/45 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-md">{album.ownedTrackCount} of {album.trackCount}</span> : undefined}
    />
  )
}

export function ArtistCard({ artist }: { artist: ArtistSummary }) {
  return (
    <Card
      to={`/artist/${artist.id}`}
      title={artist.name}
      subtitle="Artist"
      centered
      dimmed={!artist.inLibrary}
      art={artist.image ? <Cover artwork={artist.image} round dimmed={!artist.inLibrary} /> : <Monogram name={artist.name} />}
    />
  )
}

/** A round initial for artists with no image. */
export function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <div aria-hidden className={cn('flex aspect-square w-full items-center justify-center rounded-full bg-surface text-[clamp(1rem,5vw,2.75rem)] font-bold text-quiet shadow-[inset_0_0_0_1px_var(--stroke)]', className)}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}

export function PlaylistCard({ playlist, onPlay }: { playlist: PlaylistSummary; onPlay?: () => void }) {
  return (
    <Card
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      subtitle={`Playlist · ${playlist.ownerName}`}
      art={<PlaylistCover artworks={playlist.artworks} />}
      onPlay={playlist.trackCount ? onPlay : undefined}
    />
  )
}

/** A responsive grid of cards that fills the width. */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]', className)}>{children}</div>
}

/** A colored tile for browsing a genre, with a cover tilted into the corner. */
export function GenreTile({ name, color, art, onClick }: { name: string; color: string; art?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Browse ${name}`}
      style={{ backgroundColor: color }}
      className="group relative h-28 overflow-hidden rounded-2xl p-4 text-left transition duration-150 hover:brightness-110 active:scale-[0.98]"
    >
      <span className="relative z-10 text-[17px] font-bold text-[#F5F2FF]">{name}</span>
      {art
        ? <div className="absolute -bottom-3 -right-2 w-[5.5rem] rotate-[19deg] shadow-cover transition-transform duration-200 group-hover:rotate-[14deg] group-hover:scale-105">{art}</div>
        : <span aria-hidden className="absolute -bottom-6 -right-3 text-[5.5rem] font-black leading-none tracking-tighter text-white/12 transition-transform duration-200 group-hover:-rotate-6">{name.slice(0, 2)}</span>}
    </button>
  )
}
