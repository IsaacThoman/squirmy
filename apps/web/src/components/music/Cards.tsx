import type { AlbumSummary, ArtistSummary, PlaylistSummary } from '@squirmy/contracts'
import { BookmarkCheck, BookmarkPlus, MoreHorizontal, Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { usePrefetch, type PrefetchHandlers } from '@/api/prefetch'
import { IconButton } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { albumPresentation, canFetch, releaseSubtitle } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { useAlbumMenu } from '@/player/use-album-menu'
import { LikedCover, PlaylistCover } from './CollectionArt'
import { Cover } from './Cover'

type CardProps = {
  to: string
  title: string
  subtitle: ReactNode
  art: ReactNode
  onPlay?: () => void
  /** For music that does not play: a bookmark that adds it to the Wantlist, shown while wanted. */
  want?: { wanted: boolean; onChange: (wanted: boolean) => void }
  dimmed?: boolean
  /** Round artwork with centered text, for artists. */
  round?: boolean
  /** Starts loading the linked page when the card is hovered, focused or pressed. */
  prefetch?: PrefetchHandlers
  /** A menu, from the ⋯ button by the title and from a right-click on the card. */
  menu?: CardMenu
}

/** What a card's or row's menu offers. `onOpenChange` lets it load what the entries need. */
export type CardMenu = { entries: MenuEntry[]; onOpenChange?: (open: boolean) => void }

/** A button over the corner of a card's artwork. It rises in when the card is hovered or it takes focus. */
const overArt = 'absolute bottom-2 right-2 z-10 flex size-10 items-center justify-center rounded-full outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const revealed = 'translate-y-1 opacity-0 focus-visible:translate-y-0 focus-visible:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100'
/** The ⋯ button: shown while the card is hovered, it or the menu has focus, or the menu is open; always on touch screens. */
const menuRevealed = 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/card:opacity-100 md:pointer-fine:focus-visible:opacity-100 md:pointer-fine:data-[state=open]:opacity-100'

/**
 * A finger cannot hover, so a revealed button would be an invisible target over the artwork, and
 * a tap there would play instead of open. Touch screens leave it out: the art opens the page,
 * which has its own Play.
 */
const hoverOnly = 'hidden pointer-fine:flex'

/** The round play button over a card's artwork, and over a row's in the list layout. */
function PlayButton({ title, onPlay, className }: { title: string; onPlay: () => void; className?: string }) {
  return (
    <button type="button" aria-label={`Play ${title}`} onClick={onPlay} className={cn(overArt, revealed, hoverOnly, 'bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95', className)}>
      <Play className="size-4 translate-x-px" fill="currentColor" />
    </button>
  )
}

function MoreButton({ title, menu, className }: { title: string; menu: CardMenu; className?: string }) {
  return (
    <DropdownMenu
      entries={menu.entries}
      onOpenChange={menu.onOpenChange}
      trigger={<IconButton label={`More options for ${title}`} tooltip={false} className={cn('relative z-10', menuRevealed, className)}><MoreHorizontal /></IconButton>}
    />
  )
}

/** Right-clicking anywhere on the card opens its menu, as on a track row. */
function WithMenu({ menu, children }: { menu?: CardMenu; children: ReactNode }) {
  return menu ? <ContextMenu entries={menu.entries} onOpenChange={menu.onOpenChange}>{children}</ContextMenu> : children
}

/** Artwork, a title and a subtitle, linking to a page. The whole card is the link. */
function Card({ to, title, subtitle, art, onPlay, want, dimmed, round, prefetch, menu }: CardProps) {
  return (
    <WithMenu menu={menu}>
      <div className={cn('group/card relative flex min-w-0 flex-col', round && 'items-center text-center')}>
        <div className="relative w-full">
          {art}
          <div aria-hidden className={cn('pointer-events-none absolute inset-0 transition-colors duration-150 group-hover/card:bg-black/10', round ? 'rounded-full' : 'rounded-cover')} />
          {onPlay && <PlayButton title={title} onPlay={onPlay} />}
          {want && !onPlay && (
            <button
              type="button"
              aria-label={want.wanted ? `Remove ${title} from Wantlist` : `Add ${title} to Wantlist`}
              aria-pressed={want.wanted}
              onClick={() => want.onChange(!want.wanted)}
              className={cn(overArt, 'border bg-popover shadow-md hover:bg-accent', want.wanted ? 'text-primary' : cn(revealed, hoverOnly, 'text-popover-foreground'))}
            >
              {want.wanted ? <BookmarkCheck className="size-4" /> : <BookmarkPlus className="size-4" />}
            </button>
          )}
        </div>
        <div className="mt-2 flex w-full min-w-0 items-center gap-1">
          <Link
            to={to}
            title={title}
            {...prefetch}
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-medium outline-none after:absolute after:-inset-1 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring',
              dimmed && 'text-muted-foreground',
            )}
          >
            {title}
          </Link>
          {menu && <MoreButton title={title} menu={menu} className="-my-1 -mr-1 size-6 [&_svg]:size-4" />}
        </div>
        <div className={cn('w-full truncate text-xs text-muted-foreground', dimmed && 'opacity-70')}>{subtitle}</div>
      </div>
    </WithMenu>
  )
}

type AlbumCardProps = {
  album: AlbumSummary
  onPlay?: () => void
  /** Offered on albums that do not play, while the server has the Wantlist on. */
  wanted?: boolean
  onWant?: (wanted: boolean) => void
  /**
   * What the line under the title says. Artist pages show the year instead of the artist, and
   * the artist with the year on a record of someone else's that credits them.
   */
  subtitle?: 'artist' | 'year' | 'artist-year'
}

/**
 * An album that plays looks the same whether the server has all of it, part of it or none of it
 * yet: no badge, no count. It is dimmed only when nothing on it would play for this user.
 */
export function AlbumCard({ album, onPlay, wanted = false, onWant, subtitle = 'artist' }: AlbumCardProps) {
  const viewer = useViewer()
  const dimmed = albumPresentation(album, viewer) === 'dimmed'
  const prefetch = usePrefetch({ kind: 'album', id: album.id })
  const menu = useAlbumMenu(album, onPlay)
  return (
    <Card
      to={`/album/${album.id}`}
      prefetch={prefetch}
      title={album.title}
      subtitle={subtitle === 'year'
        ? releaseSubtitle(album)
        : subtitle === 'artist-year' ? [album.artistCredit, album.year].filter(Boolean).join(' · ') : album.artistCredit}
      art={<Cover artwork={album.artwork} dimmed={dimmed} />}
      onPlay={dimmed ? undefined : onPlay}
      want={dimmed && onWant ? { wanted, onChange: onWant } : undefined}
      dimmed={dimmed}
      menu={menu}
    />
  )
}

export function ArtistCard({ artist }: { artist: ArtistSummary }) {
  const prefetch = usePrefetch({ kind: 'artist', id: artist.id })
  const viewer = useViewer()
  // A requester plays any artist; for others, one with nothing in their library has little that plays.
  const dimmed = !artist.inLibrary && !canFetch(viewer)
  return (
    <Card
      to={`/artist/${artist.id}`}
      prefetch={prefetch}
      title={artist.name}
      subtitle="Artist"
      round
      dimmed={dimmed}
      art={artist.image ? <Cover artwork={artist.image} round dimmed={dimmed} /> : <Monogram name={artist.name} className={cn(dimmed && 'opacity-55')} />}
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

export function PlaylistRow({ playlist, onPlay, className }: { playlist: PlaylistSummary; onPlay?: () => void; className?: string }) {
  return (
    <CollectionRow
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      subtitle={`Playlist · ${playlist.ownerName}`}
      art={<PlaylistCover artworks={playlist.artworks} className={className} />}
      onPlay={playlist.trackCount ? onPlay : undefined}
    />
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

/** Liked Songs as a card, beside the playlists. `count` is "24 songs". */
export function LikedCard({ count, onPlay }: { count?: string; onPlay?: () => void }) {
  return <Card to="/liked" title="Liked Songs" subtitle={count ? `Playlist · ${count}` : 'Playlist'} art={<LikedCover />} onPlay={onPlay} />
}

type CollectionRowProps = {
  to: string
  title: string
  subtitle: ReactNode
  /** Square artwork, round for artists; the row sizes it. */
  art: ReactNode
  dimmed?: boolean
  prefetch?: PrefetchHandlers
  /** The card's play button, over the artwork. */
  onPlay?: () => void
  menu?: CardMenu
}

/**
 * A card laid out as a row: small artwork, the title and a subtitle. The Library's list view. It
 * keeps the card's controls: the play button over the artwork, and its menu.
 */
export function CollectionRow({ to, title, subtitle, art, dimmed, prefetch, onPlay, menu }: CollectionRowProps) {
  return (
    <WithMenu menu={menu}>
      <div className="group/card relative flex h-14 items-center gap-3 rounded-md px-2 transition-colors hover:bg-accent/60 has-[:focus-visible]:bg-accent/60 has-[[data-state=open]]:bg-accent/60 data-[state=open]:bg-accent/60">
        <div className="relative size-11 shrink-0">
          {art}
          {onPlay && <PlayButton title={title} onPlay={onPlay} className="inset-0 m-auto size-8 shadow-md" />}
        </div>
        <Link
          to={to}
          title={title}
          {...prefetch}
          className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <div dir="auto" className={cn('truncate text-sm font-medium', dimmed && 'text-muted-foreground')}>{title}</div>
          <div className={cn('truncate text-xs text-muted-foreground', dimmed && 'opacity-70')}>{subtitle}</div>
        </Link>
        {menu && <MoreButton title={title} menu={menu} className="size-8 [&_svg]:size-4" />}
      </div>
    </WithMenu>
  )
}

/** An album as a row, with the card's play button and menu. */
export function AlbumRow({ album, onPlay, className }: { album: AlbumSummary; onPlay?: () => void; className?: string }) {
  const viewer = useViewer()
  const prefetch = usePrefetch({ kind: 'album', id: album.id })
  const menu = useAlbumMenu(album, onPlay)
  const dimmed = albumPresentation(album, viewer) === 'dimmed'
  const subtitle = ['Album', album.artistCredit, album.year].filter(Boolean).join(' · ')
  return (
    <CollectionRow
      to={`/album/${album.id}`}
      title={album.title}
      subtitle={subtitle}
      dimmed={dimmed}
      prefetch={prefetch}
      onPlay={dimmed ? undefined : onPlay}
      menu={menu}
      art={<Cover artwork={album.artwork} size={96} dimmed={dimmed} className={className} />}
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
