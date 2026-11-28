import type { AlbumSummary, ArtistSummary, MixSummary, PlaylistSummary, RadioSummary } from '@squirmy/contracts'
import { BookmarkCheck, BookmarkPlus, Disc3, MicVocal, MoreHorizontal, Pin, PinOff, Play, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { usePrefetch, type PrefetchHandlers } from '@/api/prefetch'
import { IconButton } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Tooltip } from '@/components/ui/tooltip'
import { albumPresentation, canFetch, releaseSubtitle, UNAVAILABLE_LABEL } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useLibraryFailure } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { useAlbumMenu } from '@/player/use-album-menu'
import { usePlaylistMenu } from '@/player/use-playlist-menu'
import { endTrackDrag, startCollectionDrag, type CollectionDrag } from '@/lib/drag'
import { useResultMenus } from './result-menus'
import { LikedCover, MixCover, PlaylistCover, RadioCover, SmartMark } from './CollectionArt'
import { mixSlot } from './mix-menu'
import { Cover } from './Cover'

type CardProps = {
  to: string
  title: string
  subtitle: ReactNode
  art: ReactNode
  onPlay?: () => void
  /** For music that does not play: a bookmark that adds it (`id`) to the Wantlist, shown while wanted. */
  want?: { id: string; wanted: boolean; onChange: (wanted: boolean) => void }
  dimmed?: boolean
  /** Nothing on it plays for this user: said in words, not only by the gray. */
  unavailable?: boolean
  /** Round artwork with centered text, for artists. */
  round?: boolean
  /** Starts loading the linked page when the card is hovered, focused or pressed. */
  prefetch?: PrefetchHandlers
  /** A menu, from the ⋯ button by the title and from a right-click on the card. */
  menu?: CardMenu
  /** The menu from a right-click (or a long press) alone, with no ⋯ button: cards that never had one keep their look. */
  contextOnly?: boolean
  pin?: CardPin
  /** An album or playlist dragged onto a sidebar playlist, the queue or the player brings its songs. */
  drag?: CollectionDrag
}

/** What a card's or row's menu offers. `onOpenChange` lets it load what the entries need. */
export type CardMenu = { entries: MenuEntry[]; onOpenChange?: (open: boolean) => void }

/**
 * Pinning to the top of the Library's All, where the card is listed there: a pin by the
 * subtitle while pinned, and Pin or Unpin at the end of the menu.
 */
export type CardPin = { pinned: boolean; onToggle: () => void | Promise<unknown> }

/** The menu with the pin's entry added, or the pin's entry alone. */
function withPin(menu: CardMenu | undefined, pin: CardPin | undefined): CardMenu | undefined {
  if (!pin) return menu
  const entry: MenuEntry = pin.pinned
    ? { label: 'Unpin', icon: <PinOff />, onSelect: pin.onToggle }
    : { label: 'Pin to top', icon: <Pin />, onSelect: pin.onToggle }
  return { entries: [...(menu ? [...menu.entries, { kind: 'separator' as const }] : []), entry], onOpenChange: menu?.onOpenChange }
}

/** The mark of a pinned card or row, before its subtitle. */
function PinnedMark() {
  return <><Pin aria-hidden className="mr-1 inline size-3 -translate-y-px fill-current text-primary" /><span className="sr-only">Pinned, </span></>
}

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

/**
 * What an unavailable card or row says, as a track row does: the gray alone is a color cue, so the
 * subtitle leads with the words, and the link's name carries them for screen readers.
 */
function UnavailableNote() {
  return <span aria-hidden>{UNAVAILABLE_LABEL} · </span>
}
const unavailableName = <span className="sr-only"> ({UNAVAILABLE_LABEL})</span>

/** Right-clicking anywhere on the card opens its menu, as on a track row. */
function WithMenu({ menu, children }: { menu?: CardMenu; children: ReactNode }) {
  return menu ? <ContextMenu entries={menu.entries} onOpenChange={menu.onOpenChange}>{children}</ContextMenu> : children
}

/** Artwork, a title and a subtitle, linking to a page. The whole card is the link. */
function Card({ to, title, subtitle, art, onPlay, want, dimmed, unavailable, round, prefetch, menu: own, contextOnly = false, pin, drag }: CardProps) {
  const menu = withPin(own, pin)
  return (
    <WithMenu menu={menu}>
      <div
        // The card is a link, which the browser lets be dragged; this adds what the app's drop targets read.
        onDragStart={drag && (event => startCollectionDrag(event, drag))}
        onDragEnd={drag && endTrackDrag}
        className={cn('group/card relative flex min-w-0 flex-col', round && 'items-center text-center')}
      >
        <div className="relative w-full">
          {art}
          <div aria-hidden className={cn('pointer-events-none absolute inset-0 transition-colors duration-150 group-hover/card:bg-black/10', round ? 'rounded-full' : 'rounded-cover')} />
          {onPlay && <PlayButton title={title} onPlay={onPlay} />}
          {want && !onPlay && <WantButton title={title} want={want} />}
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
            {unavailable && unavailableName}
          </Link>
          {menu && (!contextOnly || pin) && <MoreButton title={title} menu={menu} className="-my-1 -mr-1 size-6 [&_svg]:size-4" />}
        </div>
        {/*
          * Words, not a target: a press on them belongs to the card's link (its pseudo-element
          * covers the card). Faded, the line is a layer of its own and would take the press.
          */}
        <div className={cn('pointer-events-none w-full truncate text-xs text-muted-foreground', dimmed && 'opacity-70')}>{pin?.pinned && <PinnedMark />}{unavailable && <UnavailableNote />}{subtitle}</div>
      </div>
    </WithMenu>
  )
}

/**
 * The card's Wantlist bookmark. A change the server refuses goes back, and says so beside the
 * bookmark for a few seconds, which stays in sight meanwhile.
 */
function WantButton({ title, want }: { title: string; want: NonNullable<CardProps['want']> }) {
  const failure = useLibraryFailure(`want:${want.id}`)
  const label = want.wanted ? `Remove ${title} from Wantlist` : `Add ${title} to Wantlist`
  // Always in a tooltip, open only for a failure: the button stays the same element, and keeps focus, when one comes.
  return (
    <Tooltip label={failure ?? label} open={Boolean(failure)} tone="error">
      <button
        type="button"
        aria-label={label}
        aria-pressed={want.wanted}
        onClick={() => want.onChange(!want.wanted)}
        className={cn(overArt, 'border bg-popover shadow-md hover:bg-accent', want.wanted || failure ? 'text-primary' : cn(revealed, hoverOnly, 'text-popover-foreground'), failure && 'opacity-100')}
      >
        {want.wanted ? <BookmarkCheck className="size-4" /> : <BookmarkPlus className="size-4" />}
      </button>
    </Tooltip>
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
  pin?: CardPin
}

/**
 * An album that plays looks the same whether the server has all of it, part of it or none of it
 * yet: no badge, no count. It is dimmed only when nothing on it would play for this user.
 */
export function AlbumCard({ album, onPlay, wanted = false, onWant, subtitle = 'artist', pin }: AlbumCardProps) {
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
      want={dimmed && onWant ? { id: album.id, wanted, onChange: onWant } : undefined}
      dimmed={dimmed}
      unavailable={dimmed}
      menu={menu}
      pin={pin}
      drag={{ kind: 'album', id: album.id, title: album.title }}
    />
  )
}

export function ArtistCard({ artist, pin }: { artist: ArtistSummary; pin?: CardPin }) {
  const prefetch = usePrefetch({ kind: 'artist', id: artist.id })
  const viewer = useViewer()
  const menus = useResultMenus()
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
      pin={pin}
      menu={{ entries: menus({ type: 'artist', artist }) }}
      contextOnly
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

/** "Playlist · Mira", or with the smart mark "Smart playlist · Mira". */
function PlaylistKind({ playlist }: { playlist: PlaylistSummary }) {
  if (!playlist.smart) return `Playlist · ${playlist.ownerName}`
  return <><SmartMark className="mr-1 inline size-3 align-[-0.125em]" />Smart playlist · {playlist.ownerName}</>
}

export function PlaylistRow({ playlist, onPlay, className, pin }: { playlist: PlaylistSummary; onPlay?: () => void; className?: string; pin?: CardPin }) {
  return (
    <CollectionRow
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      subtitle={<PlaylistKind playlist={playlist} />}
      art={<PlaylistCover artworks={playlist.artworks} className={className} />}
      onPlay={playlist.trackCount ? onPlay : undefined}
      pin={pin}
    />
  )
}

export function PlaylistCard({ playlist, onPlay, pin }: { playlist: PlaylistSummary; onPlay?: () => void; pin?: CardPin }) {
  const menu = usePlaylistMenu(playlist, onPlay)
  return (
    <Card
      to={`/playlist/${playlist.id}`}
      title={playlist.name}
      subtitle={<PlaylistKind playlist={playlist} />}
      art={<PlaylistCover artworks={playlist.artworks} />}
      onPlay={playlist.trackCount ? onPlay : undefined}
      pin={pin}
      menu={menu}
      contextOnly
      drag={{ kind: 'playlist', id: playlist.id, title: playlist.name }}
    />
  )
}

/** A mix made for the user (Home's Made for you): its cover, name and leading artists. */
export function MixCard({ mix, onPlay, menu }: { mix: MixSummary; onPlay?: () => void; menu?: CardMenu }) {
  return (
    <Card
      to={`/mix/${mix.id}`}
      title={mix.name}
      subtitle={mix.description}
      art={<MixCover artworks={mix.artworks} label={mixSlot(mix)} />}
      onPlay={mix.trackCount ? onPlay : undefined}
      menu={menu}
      drag={mix.trackCount ? { kind: 'mix', id: mix.id, title: mix.name } : undefined}
    />
  )
}

/**
 * A radio the user played, started again from its play button. It opens the artist it
 * started from, or the album of its song. Its right-click menu starts it or goes there; it
 * has no queue entries and is not dragged, as its songs are only picked once it starts.
 */
export function RadioCard({ radio, onPlay }: { radio: RadioSummary; onPlay: () => void }) {
  const navigate = useNavigate()
  const round = radio.seed === 'artist'
  const to = radio.seed === 'artist' ? `/artist/${radio.id}` : radio.albumId ? `/album/${radio.albumId}` : '/'
  const goTo: MenuEntry[] = radio.seed === 'artist'
    ? [{ label: 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(to) }]
    : radio.albumId ? [{ label: 'Go to album', icon: <Disc3 />, onSelect: () => navigate(to) }] : []
  const menu: CardMenu = { entries: [{ label: 'Start radio', icon: <Radio />, onSelect: onPlay }, ...(goTo.length ? [{ kind: 'separator' as const }, ...goTo] : [])] }
  return (
    <Card
      to={to}
      title={`${radio.title} Radio`}
      subtitle={radio.subtitle ? `Radio · ${radio.subtitle}` : 'Radio'}
      round={round}
      art={<RadioCover artwork={radio.artwork} round={round} />}
      onPlay={onPlay}
      menu={menu}
      contextOnly
    />
  )
}

/** Liked Songs as a card, beside the playlists. `count` is "24 songs". */
export function LikedCard({ count, onPlay, pin }: { count?: string; onPlay?: () => void; pin?: CardPin }) {
  return <Card to="/liked" title="Liked Songs" subtitle={count ? `Playlist · ${count}` : 'Playlist'} art={<LikedCover />} onPlay={onPlay} pin={pin} />
}

type CollectionRowProps = {
  to: string
  title: string
  subtitle: ReactNode
  /** Square artwork, round for artists; the row sizes it. */
  art: ReactNode
  dimmed?: boolean
  /** Nothing on it plays for this user, as on a card. */
  unavailable?: boolean
  prefetch?: PrefetchHandlers
  /** The card's play button, over the artwork. */
  onPlay?: () => void
  menu?: CardMenu
  pin?: CardPin
}

/**
 * A card laid out as a row: small artwork, the title and a subtitle. The Library's list view. It
 * keeps the card's controls: the play button over the artwork, and its menu.
 */
export function CollectionRow({ to, title, subtitle, art, dimmed, unavailable, prefetch, onPlay, menu: own, pin }: CollectionRowProps) {
  const menu = withPin(own, pin)
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
          <div dir="auto" className={cn('truncate text-sm font-medium', dimmed && 'text-muted-foreground')}>{title}{unavailable && unavailableName}</div>
          {/* Words, not a target, as on a card: a press on them belongs to the row's link. */}
          <div className={cn('pointer-events-none truncate text-xs text-muted-foreground', dimmed && 'opacity-70')}>{pin?.pinned && <PinnedMark />}{unavailable && <UnavailableNote />}{subtitle}</div>
        </Link>
        {menu && <MoreButton title={title} menu={menu} className="size-8 [&_svg]:size-4" />}
      </div>
    </WithMenu>
  )
}

/** An album as a row, with the card's play button and menu. */
export function AlbumRow({ album, onPlay, className, pin }: { album: AlbumSummary; onPlay?: () => void; className?: string; pin?: CardPin }) {
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
      unavailable={dimmed}
      prefetch={prefetch}
      onPlay={dimmed ? undefined : onPlay}
      menu={menu}
      pin={pin}
      art={<Cover artwork={album.artwork} size={96} dimmed={dimmed} className={className} />}
    />
  )
}

/** A responsive grid of cards that fills the width. */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] compact:sm:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]', className)}>{children}</div>
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
