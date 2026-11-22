import type { AlbumSummary, ArtistSummary, PlaylistSummary } from '@squirmy/contracts'
import { BookmarkCheck, BookmarkPlus, CloudDownload, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { usePrefetch, type PrefetchHandlers } from '@/api/prefetch'
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
  /** Round artwork with centered text, for artists. */
  round?: boolean
  /** Starts loading the linked page when the card is hovered, focused or pressed. */
  prefetch?: PrefetchHandlers
}

/** A button over the corner of a card's artwork. It rises in when the card is hovered or it takes focus. */
const overArt = 'absolute bottom-2 right-2 z-10 flex size-10 items-center justify-center rounded-full outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const revealed = 'translate-y-1 opacity-0 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100'

/** Artwork, a title and a subtitle, linking to a page. The whole card is the link. */
function Card({ to, title, subtitle, art, onPlay, want, dimmed, badge, round, prefetch }: CardProps) {
  return (
    <div className={cn('group/card relative flex min-w-0 flex-col', round && 'items-center text-center')}>
      <div className="relative w-full">
        {art}
        <div aria-hidden className={cn('pointer-events-none absolute inset-0 transition-colors duration-150 group-hover/card:bg-black/10', round ? 'rounded-full' : 'rounded-cover')} />
        {badge && <div className="absolute left-1.5 top-1.5">{badge}</div>}
        {onPlay && (
          <button type="button" aria-label={`Play ${title}`} onClick={onPlay} className={cn(overArt, revealed, 'bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95')}>
            <Play className="size-4 translate-x-px" fill="currentColor" />
          </button>
        )}
        {want && !onPlay && (
          <button
            type="button"
            aria-label={want.wanted ? `Remove ${title} from Wantlist` : `Add ${title} to Wantlist`}
            aria-pressed={want.wanted}
            onClick={() => want.onChange(!want.wanted)}
            className={cn(overArt, 'border bg-popover shadow-md hover:bg-accent', want.wanted ? 'text-primary' : cn(revealed, 'text-popover-foreground'))}
          >
            {want.wanted ? <BookmarkCheck className="size-4" /> : <BookmarkPlus className="size-4" />}
          </button>
        )}
      </div>
      <Link
        to={to}
        title={title}
        {...prefetch}
        className={cn(
          'mt-2 w-full truncate text-sm font-medium outline-none after:absolute after:-inset-1 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring',
          dimmed && 'text-muted-foreground',
        )}
      >
        {title}
      </Link>
      <div className={cn('w-full truncate text-xs text-muted-foreground', dimmed && 'opacity-70')}>{subtitle}</div>
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
  const prefetch = usePrefetch({ kind: 'album', id: album.id })
  return (
    <Card
      to={`/album/${album.id}`}
      prefetch={prefetch}
      title={album.title}
      subtitle={subtitle === 'year' ? [album.year, albumTypeLabel(album.type)].filter(Boolean).join(' · ') : album.artistCredit}
      art={<Cover artwork={album.artwork} dimmed={dimmed} className={cn(onDemand && 'opacity-80')} />}
      onPlay={unowned ? undefined : onPlay}
      want={unowned && onWant ? { wanted, onChange: onWant } : undefined}
      dimmed={dimmed}
      badge={onDemand
        // Above the card's link, so the tooltip can be reached.
        ? <Tooltip label="Plays on demand"><span className="relative z-10 flex size-6 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-md"><CloudDownload aria-label="Plays on demand" className="size-3.5" /></span></Tooltip>
        : partial ? <span className="flex h-5 items-center rounded-md bg-black/50 px-1.5 text-xs font-medium tabular text-white backdrop-blur-md">{album.ownedTrackCount} of {album.trackCount}</span> : undefined}
    />
  )
}

export function ArtistCard({ artist }: { artist: ArtistSummary }) {
  const prefetch = usePrefetch({ kind: 'artist', id: artist.id })
  return (
    <Card
      to={`/artist/${artist.id}`}
      prefetch={prefetch}
      title={artist.name}
      subtitle="Artist"
      round
      dimmed={!artist.inLibrary}
      art={artist.image ? <Cover artwork={artist.image} round dimmed={!artist.inLibrary} /> : <Monogram name={artist.name} className={cn(!artist.inLibrary && 'opacity-55')} />}
    />
  )
}

/** A round initial for artists with no image. A `className` sets its size and the size of its letter. */
export function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <div aria-hidden className={cn('flex aspect-square w-full select-none items-center justify-center rounded-full bg-muted text-4xl font-medium text-muted-foreground ring-1 ring-inset ring-foreground/10', className)}>
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
  return <div className={cn('grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]', className)}>{children}</div>
}

/** A colored tile for browsing a genre, with a cover tilted into the corner, or a record where there is none. */
export function GenreTile({ name, color, art, onClick }: { name: string; color: string; art?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Browse ${name}`}
      style={{ backgroundColor: color }}
      className="group relative h-24 overflow-hidden rounded-xl p-3.5 text-left outline-none transition-[filter] duration-150 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="relative z-10 line-clamp-2 max-w-[70%] text-base font-semibold leading-snug text-white">{name}</span>
      {art
        ? <div className="absolute -bottom-2 -right-2 w-16 rotate-12 shadow-cover">{art}</div>
        : (
          <span aria-hidden className="absolute -bottom-9 -right-9 flex size-28 items-center justify-center rounded-full border border-white/15 bg-white/5">
            <span className="flex size-[4.5rem] items-center justify-center rounded-full border border-white/15">
              <span className="size-7 rounded-full bg-white/15" />
            </span>
          </span>
        )}
    </button>
  )
}
