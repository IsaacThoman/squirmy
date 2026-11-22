import type { AlbumSummary, ArtistSummary, PlaylistSummary } from '@squirmy/contracts'
import { ArrowUpRight, BookmarkCheck, BookmarkPlus, CloudDownload, Play } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
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

const revealOnHover = 'pointer-fine:translate-y-1 pointer-fine:opacity-0 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100'

/** Artwork, a title and a subtitle, linking to a page. A play button rises on hover. */
function Card({ to, title, subtitle, art, onPlay, want, dimmed, badge, centered }: CardProps) {
  return (
    <div className={cn('group/card relative -m-1.5 flex min-w-0 flex-col rounded-xl border border-transparent p-1.5 transition-colors hover:border-stroke hover:bg-sheet focus-within:border-stroke focus-within:bg-sheet', centered && 'items-center text-center')}>
      <div className="relative w-full">
        {art}
        {badge && <div className="absolute left-2 top-2">{badge}</div>}
        {onPlay && (
          <button
            type="button"
            aria-label={`Play ${title}`}
            onClick={onPlay}
            className={cn('absolute bottom-2 right-2 z-10 flex size-9 items-center justify-center rounded-full bg-accent text-on-accent shadow-cover transition duration-150 hover:scale-105', revealOnHover)}
          >
            <Play className="size-4 translate-x-px" fill="currentColor" />
          </button>
        )}
        {want && !onPlay && (
          <button
            type="button"
            aria-label={want.wanted ? `Remove ${title} from Wantlist` : `Add ${title} to Wantlist`}
            aria-pressed={want.wanted}
            onClick={() => want.onChange(!want.wanted)}
            className={cn(
              'absolute bottom-2 right-2 z-10 flex size-9 items-center justify-center rounded-full bg-sheet text-accent shadow-cover transition duration-150 hover:scale-105',
              !want.wanted && revealOnHover,
            )}
          >
            {want.wanted ? <BookmarkCheck className="size-4" /> : <BookmarkPlus className="size-4" />}
          </button>
        )}
      </div>
      <Link to={to} title={title} className={cn('mt-2.5 w-full truncate text-sm font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent', dimmed && 'text-quiet')}>
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

/** A genre shortcut, optionally with a cover from that genre. */
export function GenreTile({ name, color, art, onClick }: { name: string; color: string; art?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Browse ${name}`}
      style={{ '--genre-color': color } as CSSProperties}
      className="group flex min-h-16 items-center justify-between gap-2 overflow-hidden rounded-xl border border-stroke bg-[color-mix(in_srgb,var(--genre-color)_13%,var(--sheet))] px-4 py-2 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--genre-color)_23%,var(--sheet))]"
    >
      <span className="min-w-0 break-words text-sm font-semibold">{name}</span>
      {art
        ? <div aria-hidden className="w-10 shrink-0 transition-transform group-hover:rotate-6">{art}</div>
        : <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />}
    </button>
  )
}
