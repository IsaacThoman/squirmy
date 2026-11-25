import type { AlbumDisc, TrackSummary } from '@squirmy/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Clock3, Disc3, MoreHorizontal, Pause, Play } from 'lucide-react'
import { Fragment, memo, useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type RefObject } from 'react'
import { useNavigate } from 'react-router'
import { useScrollContainer } from '@/components/layout/scroll-context'
import { ExplicitBadge, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { isPlayable, UNAVAILABLE_LABEL } from '@/lib/catalog'
import { draggedTracks, endTrackDrag, startTrackDrag } from '@/lib/drag'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { PlayerControlsContext, useTrackPlayback } from '@/player/player-context'
import { ArtistLinks } from './ArtistLinks'
import { Cover } from './Cover'
import { Equalizer } from './Equalizer'
import { SaveHeart } from './LibrarySave'
import { PrefetchLink } from './PrefetchLink'
import { trackMenuEntries } from './track-menu'
import { useEndReached } from './use-end-reached'

/**
 * `like` is the heart, which saves the track to the library or takes it out. `add-to:<playlist id>`
 * adds the track to a playlist; `add-to:new` starts one with it.
 */
export type TrackAction = 'play-next' | 'enqueue' | 'like' | 'want' | 'radio' | 'remove' | 'move-up' | 'move-down' | `add-to:${string}`

export type PlaylistChoice = { id: string; name: string }

/**
 * - `album`: track numbers, no artwork, and the artists only on songs whose credit differs from
 *   the album's (`albumCredit`), as the iOS app does; for album pages.
 * - `playlist`: running numbers, artwork, album and (when the rows have `addedAt`) date added columns.
 * - `compact`: artwork instead of numbers, album column on wide screens; search and top tracks.
 */
export type TrackListVariant = 'album' | 'playlist' | 'compact'

type SharedProps = {
  variant?: TrackListVariant
  isWanted?: (track: TrackSummary) => boolean
  onPlay: (index: number) => void
  /** Resolves (or rejects) for the actions that answer later: the menu entry waits for those. */
  onAction?: (action: TrackAction, track: TrackSummary, index: number) => void | Promise<unknown>
  /** Playlists the track menu offers to add to. */
  playlists?: PlaylistChoice[]
  /** Makes the rows reorderable by dragging and from the menu (a playlist the user owns). */
  onMove?: (from: number, to: number) => void
  /** On an album page, the album's credit: a song credited the same says nothing under its title. */
  albumCredit?: string
}

/**
 * A row is its own size container, and its columns follow its width rather than the window's: the
 * sidebar, the queue and a page's own columns all change how much room a list has. As a row
 * narrows it gives up the album first, then the date added, then the duration; the title and
 * artist truncate; the heart and the menu never go. From 36rem a compact row's album gets a
 * column; a playlist's date added does from 42rem and its album from 56rem (from 42rem when it has
 * no dates). The duration shows from 20rem.
 */
const columns: Record<TrackListVariant, string> = {
  album: 'grid-cols-[2rem_minmax(0,1fr)_auto]',
  playlist: 'grid-cols-[2rem_minmax(0,1fr)_auto] @2xl:grid-cols-[2rem_minmax(0,1fr)_7rem_auto] @4xl:grid-cols-[2rem_minmax(0,6fr)_minmax(0,4fr)_7rem_auto]',
  compact: 'grid-cols-[minmax(0,1fr)_auto] @xl:grid-cols-[minmax(0,6fr)_minmax(0,4fr)_auto]',
}

/** A playlist's rows have a date added column only when they know the date. */
const columnsOf = (variant: TrackListVariant, dated: boolean) => (variant === 'playlist' && !dated ? undatedColumns : columns[variant])
const undatedColumns = 'grid-cols-[2rem_minmax(0,1fr)_auto] @2xl:grid-cols-[2rem_minmax(0,6fr)_minmax(0,4fr)_auto]'

/** The column a variant's rows give the album from the width that has room for it. */
const albumColumns = { album: undefined, playlist: 'hidden @2xl:block', compact: 'hidden @xl:block' } satisfies Record<TrackListVariant, string | undefined>
/** A dated playlist keeps its dates longer than its albums. */
const albumColumnOf = (variant: TrackListVariant, dated: boolean) => (variant === 'playlist' && dated ? 'hidden @4xl:block' : albumColumns[variant])

/**
 * The last column: like, duration, menu. The header's has the same width, so the columns between
 * line up with the rows'.
 */
const actionsColumn = 'flex shrink-0 items-center justify-end gap-1 @xs:min-w-28 pointer-coarse:gap-0 pointer-coarse:@xs:min-w-32'

/**
 * Controls that appear when their row is hovered, has the keyboard's focus anywhere in it or has
 * its menu open. Phones and touch screens, which cannot hover, always show them.
 */
const revealed = 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/row:opacity-100 md:pointer-fine:group-data-[state=open]/row:opacity-100 md:pointer-fine:group-has-[:focus-visible]/row:opacity-100 md:pointer-fine:group-has-[[data-state=open]]/row:opacity-100'

/** The heart and the menu button: a finger's 44 px on touch screens, with no gap between them. */
const rowAction = 'pointer-coarse:size-11'

/**
 * How many of the links in `box`, a line cut short with an ellipsis, are drawn whole: the rest
 * leave the Tab order, stops with nothing to see. It follows the line's width (the row's columns
 * change with the window, the sidebar and the queue) and its words (`text`). The row's menu goes
 * to the album and each artist whatever is cut.
 */
function useWholeLinks(box: RefObject<HTMLElement | null>, text: string): number {
  const [whole, setWhole] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const edge = element.getBoundingClientRect().right
      let count = 0
      // A half pixel of slack: a link that ends at the edge is whole, however its width rounds.
      for (const link of element.querySelectorAll('a')) {
        if (link.getBoundingClientRect().right > edge + 0.5) break
        count += 1
      }
      setWhole(count)
    }
    // Measured when the observer first reports, after the frame's own layout, rather than here,
    // which would lay the page out again for each row a scrolling list mounts. Until then every
    // link stays in the Tab order.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [box, text])
  return whole
}

/** Where a row dragged within its list would land: before or after the row under the pointer. */
type DropTarget = { index: number; side: 'before' | 'after' }
type Reorder = { list: string; count: number; target: DropTarget | null; setTarget: (target: DropTarget | null) => void; onMove: (from: number, to: number) => void }

type TrackRowProps = Omit<SharedProps, 'onPlay' | 'isWanted' | 'onMove'> & {
  track: TrackSummary
  index: number
  /** The number in the first column; defaults to the row's position. */
  number?: number
  addedAt?: string
  wanted?: boolean
  onPlay: () => void
  /** Owners such as the queue add their own entries to the menu. */
  extraMenu?: MenuEntry[]
  reorder?: Reorder
  style?: CSSProperties
}

/**
 * One song. A song that plays looks the same wherever its file is (on the server, or fetched
 * as it plays); one that does not is gray and says "Not available".
 */
export function TrackRow({ track, index, number, addedAt, variant = 'album', wanted, onPlay, onAction, playlists, extraMenu, reorder, style, albumCredit }: TrackRowProps) {
  const navigate = useNavigate()
  const viewer = useViewer()
  const controls = useContext(PlayerControlsContext)
  // Only this row's part of the session: it renders again when it becomes or stops being the current track, or that track plays, pauses or waits.
  const playback = useTrackPlayback(track.id)
  const { liked } = track
  const unavailable = playback === 'failed' || !isPlayable(track, viewer)
  const current = playback !== null && playback !== 'failed'
  const playing = playback === 'playing' || playback === 'loading'
  const loading = playback === 'loading'
  const play = current ? controls?.togglePlay ?? onPlay : onPlay
  const act = (action: TrackAction) => onAction?.(action, track, index)
  /**
   * A finger cannot hover to find the play button over the number or the artwork, so on a touch
   * screen a tap anywhere on the row plays it, as music apps do; the links and buttons in the
   * row keep their own taps. A mouse keeps the double-click, so a click can select text or a row.
   */
  const pointer = useRef<string | null>(null)
  const onRowClick = (event: MouseEvent) => {
    if (unavailable || pointer.current !== 'touch') return
    if ((event.target as Element).closest('a, button, [role=menuitem]')) return
    play()
  }

  // Album rows are on that album's page already.
  const menu = trackMenuEntries(track, { unavailable, wanted, playlists, act, navigate, extraMenu, reorder: reorder && { index, count: reorder.count }, onAlbumPage: variant === 'album' })

  const onDragOver = (event: DragEvent) => {
    const drag = draggedTracks(event)
    if (!reorder || drag?.list !== reorder.list) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const side = drag.index < index ? 'after' : 'before'
    const target = drag.index === index ? null : { index, side } as const
    if (target?.index !== reorder.target?.index || target?.side !== reorder.target?.side) reorder.setTarget(target)
  }
  const onDrop = (event: DragEvent) => {
    const drag = draggedTracks(event)
    if (!reorder || drag?.list !== reorder.list) return
    event.preventDefault()
    reorder.setTarget(null)
    if (drag.index !== index) reorder.onMove(drag.index, index)
  }
  const dropSide = reorder?.target?.index === index ? reorder.target.side : undefined

  const album = variant === 'album'
  // Over artwork the button and the markers are white; in the number column they take the text's colors.
  const playButton = (overArt: boolean) => !unavailable && (
    <button
      type="button"
      data-slot="row-play"
      aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
      onClick={play}
      className={cn(
        'peer absolute inset-0 flex items-center justify-center opacity-0 outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 group-data-[state=open]/row:opacity-100',
        overArt ? 'rounded-[5px] text-white' : 'rounded-md text-foreground',
      )}
    >
      {playing ? <Pause className="size-3.5" fill="currentColor" /> : <Play className="size-3.5" fill="currentColor" />}
    </button>
  )
  const marker = (overArt: boolean) => (loading
    ? <Spinner label="Loading" className={cn('size-4', overArt ? 'text-white' : 'text-primary')} />
    : current ? <Equalizer playing={playing} className={cn(overArt && 'text-white')} /> : null)
  /**
   * What the play button replaces while the row is hovered or the button has focus. Faded out it
   * still paints over the button (its opacity makes it a layer of its own), so it lets clicks through.
   */
  const resting = cn('pointer-events-none transition-opacity', !unavailable && 'group-hover/row:opacity-0 group-data-[state=open]/row:opacity-0 peer-focus-visible:opacity-0')

  const creditLine = useRef<HTMLDivElement>(null)
  const wholeCredits = useWholeLinks(creditLine, track.artistCredit)
  const albumLine = useRef<HTMLDivElement>(null)
  const albumWhole = useWholeLinks(albumLine, track.album?.title ?? '') > 0
  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      <span title={track.title} className={cn('truncate text-sm font-medium', unavailable && 'text-faded-foreground')}>{track.title}</span>
      {track.explicit && <ExplicitBadge />}
      {unavailable && <span className="sr-only">({UNAVAILABLE_LABEL})</span>}
    </div>
  )
  // Under the title. On an album page only where they are not the album's own (a featured artist):
  // a column repeating the album's artist on every row says nothing.
  const showArtists = !album || albumCredit === undefined || track.artistCredit !== albumCredit
  // A link the ellipsis cuts leaves the Tab order (`useWholeLinks`); the tooltip has the whole credit.
  const artists = (
    <div ref={creditLine} title={track.artistCredit} className={cn('min-w-0 truncate text-xs', unavailable ? 'text-faded-foreground' : 'text-muted-foreground')}>
      <ArtistLinks credit={track} plain={unavailable} focusable={index => index < wholeCredits} />
    </div>
  )

  return (
    <ContextMenu entries={menu}>
      <li
        data-slot="track-row"
        aria-current={current ? 'true' : undefined}
        // Only playing is unavailable, and the title says so to screen readers; the heart and the
        // menu still work, so the row is not marked disabled (that would disable them too).
        title={unavailable ? UNAVAILABLE_LABEL : undefined}
        onDoubleClick={unavailable ? undefined : play}
        onPointerDown={event => { pointer.current = event.pointerType }}
        onClick={onRowClick}
        draggable
        onDragStart={event => startTrackDrag(event, { tracks: [track], list: reorder?.list ?? null, index })}
        onDragEnd={() => {
          endTrackDrag()
          reorder?.setTarget(null)
        }}
        onDragOver={reorder && onDragOver}
        onDrop={reorder && onDrop}
        data-drop={dropSide}
        style={style}
        className={cn(
          'group/row @container select-none rounded-md px-2 transition-colors data-[state=open]:bg-accent/60',
          'data-[drop=after]:shadow-[inset_0_-2px_0_var(--primary)] data-[drop=before]:shadow-[inset_0_2px_0_var(--primary)]',
          // Gray, but at 3:1 or more in every theme (`color-themes.test.ts`), so the song can still be read.
          unavailable ? 'text-faded-foreground' : 'hover:bg-accent/60 has-[:focus-visible]:bg-accent/60 has-[[data-state=open]]:bg-accent/60 pointer-coarse:active:bg-accent/60',
          // The playing song also has a quiet fill: in themes whose action color is close to the
          // text (Pulpo's near-white or near-black) its title's color alone does not stand out.
          current && 'bg-accent/40',
        )}
      >
        <div className={cn('grid h-11 content-center items-center gap-x-3', columnsOf(variant, addedAt !== undefined))}>
          {variant === 'compact' ? null : (
            <div className={cn('relative flex h-8 items-center justify-center text-sm tabular', unavailable ? 'text-faded-foreground' : 'text-muted-foreground')}>
              {playButton(false)}
              <span className={resting}>{marker(false) ?? number ?? index + 1}</span>
            </div>
          )}

          {album ? <div className="min-w-0">{title}{showArtists && artists}</div> : (
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative size-8 shrink-0">
                <Cover artwork={track.album?.artwork ?? null} size={96} dimmed={unavailable} className="size-8 rounded-[5px]" />
                {variant === 'compact' && (
                  <div className={cn('absolute inset-0 flex items-center justify-center rounded-[5px] transition-colors', current ? 'bg-black/50' : !unavailable && 'group-hover/row:bg-black/50 group-data-[state=open]/row:bg-black/50 has-[:focus-visible]:bg-black/50')}>
                    {playButton(true)}
                    <span className={resting}>{marker(true)}</span>
                  </div>
                )}
              </div>
              <div className="min-w-0">
                {title}
                {artists}
              </div>
            </div>
          )}

          {albumColumnOf(variant, addedAt !== undefined) && (
            <div ref={albumLine} className={cn('min-w-0 truncate text-sm', unavailable ? 'text-faded-foreground' : 'text-muted-foreground', albumColumnOf(variant, addedAt !== undefined))}>
              {track.album && <PrefetchLink kind="album" id={track.album.id} to={`/album/${track.album.id}`} title={track.album.title} tabIndex={albumWhole ? undefined : -1} className={cn('hover:underline', !unavailable && 'hover:text-foreground')}>{track.album.title}</PrefetchLink>}
            </div>
          )}
          {variant === 'playlist' && addedAt !== undefined && <div className="hidden truncate text-sm text-muted-foreground @2xl:block">{formatRelative(addedAt)}</div>}

          <div className={actionsColumn}>
            {onAction && <SaveHeart id={track.id} liked={liked} onToggle={() => act('like')} title={track.title} tooltip={false} size="sm" className={cn(rowAction, !liked && revealed)} />}
            <span className={cn('hidden min-w-10 shrink-0 whitespace-nowrap text-right text-xs tabular @xs:block', unavailable ? 'text-faded-foreground' : 'text-muted-foreground')}>{track.durationMs ? formatDuration(track.durationMs) : '–'}</span>
            <DropdownMenu
              entries={menu}
              trigger={(
                <IconButton label={`More options for ${track.title}`} tooltip={false} size="sm" className={cn(rowAction, revealed)}>
                  <MoreHorizontal />
                </IconButton>
              )}
            />
          </div>
        </div>
      </li>
    </ContextMenu>
  )
}

/** The names of the columns, laid out as a row is so that they sit over them. */
function ListHeader({ variant, dated }: { variant: TrackListVariant; dated: boolean }) {
  return (
    <div aria-hidden className="@container mb-1 border-b px-2 text-xs font-medium text-muted-foreground">
      <div className={cn('grid h-8 items-center gap-x-3', columnsOf(variant, dated))}>
        {variant !== 'compact' && <span className="text-center">#</span>}
        <span>Title</span>
        {albumColumnOf(variant, dated) && <span className={albumColumnOf(variant, dated)}>Album</span>}
        {variant === 'playlist' && dated && <span className="hidden @2xl:block">Added</span>}
        {/* The clock sits over the durations, which end where the menu button starts. */}
        <span className={cn(actionsColumn, 'pr-9 pointer-coarse:pr-11')}><Clock3 className="hidden size-3.5 @xs:block" /></span>
      </div>
    </div>
  )
}

export function DiscHeader({ disc, title }: { disc: number; title: string | null }) {
  return (
    <li className="flex h-10 items-end gap-3 px-2 pb-2 text-xs font-medium text-muted-foreground first:h-8">
      <span className="flex w-8 justify-center"><Disc3 aria-hidden className="size-3.5" /></span>
      <span>Disc {disc}{title && <span className="font-normal"> · {title}</span>}</span>
    </li>
  )
}

type TrackListProps = SharedProps & {
  tracks: TrackSummary[]
  /** Album pages pass their discs to get a header per disc when there is more than one. */
  discs?: AlbumDisc[]
  /** Parallel to `tracks`; the playlist variant shows it. */
  addedAt?: string[]
  header?: boolean
  label: string
}

/** Drag state for lists whose rows can be reordered. */
function useReorder(count: number, onMove: SharedProps['onMove']): Reorder | undefined {
  const list = useId()
  const [target, setTarget] = useState<DropTarget | null>(null)
  return onMove && { list, count, target, setTarget, onMove }
}

export function TrackList({ tracks, discs, addedAt, header = true, label, variant = 'album', isWanted, onPlay, onMove, ...rest }: TrackListProps) {
  const reorder = useReorder(tracks.length, onMove)
  const showDiscs = discs && discs.length > 1
  const starts = discs?.map((_, index) => discs.slice(0, index).reduce((sum, disc) => sum + disc.tracks.length, 0)) ?? []
  const rows = (items: TrackSummary[], start: number) => items.map((track, i) => (
    <TrackRow
      key={`${track.id}-${start + i}`}
      track={track}
      index={start + i}
      number={variant === 'album' ? track.position ?? start + i + 1 : undefined}
      addedAt={addedAt?.[start + i]}
      variant={variant}
      wanted={isWanted?.(track)}
      onPlay={() => onPlay(start + i)}
      reorder={reorder}
      {...rest}
    />
  ))
  return (
    <div>
      {header && <ListHeader variant={variant} dated={addedAt !== undefined} />}
      <ol aria-label={label} className="flex flex-col">
        {showDiscs
          ? discs.map((disc, index) => (
            <Fragment key={disc.disc}>
              <DiscHeader disc={disc.disc} title={disc.title} />
              {rows(disc.tracks, starts[index])}
            </Fragment>
          ))
          : rows(tracks, 0)}
      </ol>
    </div>
  )
}

/** The height of a row with artwork, `h-11`. */
const rowHeight = 44

/** The same rows, rendered only near the viewport. For the whole library's songs. */
type VirtualTrackListProps = Omit<TrackListProps, 'variant' | 'discs' | 'addedAt' | 'header' | 'onMove'> & {
  /** The variants whose rows are one height at every width. */
  variant?: Exclude<TrackListVariant, 'album'>
  /** Called as the last rows come into view, to load the next page. */
  onEndReached?: () => void
}

export function VirtualTrackList({ tracks, label, variant = 'compact', isWanted, onPlay, onEndReached, ...rest }: VirtualTrackListProps) {
  const scroller = useScrollContainer()
  const list = useRef<HTMLOListElement>(null)
  const [margin, setMargin] = useState(0)

  useLayoutEffect(() => {
    if (!scroller || !list.current) return
    setMargin(list.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
  }, [scroller])

  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    overscan: 8,
    scrollMargin: margin,
    initialRect: { width: 1024, height: 900 },

    // Where the page is now: left at 0, the virtualizer scrolls the page back to the top as it
    // mounts, undoing Back's scroll restoration.
    initialOffset: () => scroller?.scrollTop ?? 0,
  })
  const last = virtualizer.getVirtualItems().at(-1)?.index ?? -1
  useEndReached(last, tracks.length, onEndReached)

  return (
    <div>
      <ListHeader variant={variant} dated={false} />
      <ol ref={list} aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const track = tracks[item.index]
          return (
            <VirtualTrackRow
              key={item.key}
              track={track}
              index={item.index}
              y={item.start - margin}
              variant={variant}
              wanted={isWanted?.(track)}
              onPlayAt={onPlay}
              {...rest}
            />
          )
        })}
      </ol>
    </div>
  )
}

type VirtualTrackRowProps = Omit<TrackRowProps, 'onPlay' | 'style'> & { y: number; onPlayAt: (index: number) => void }

/**
 * A row of `VirtualTrackList`. The virtualizer renders the list on every scroll event; a row
 * whose song and place are the same is not rendered again, so a scroll frame costs only the
 * rows coming into view.
 */
const VirtualTrackRow = memo(function VirtualTrackRow({ y, onPlayAt, index, ...props }: VirtualTrackRowProps) {
  return (
    <TrackRow
      {...props}
      index={index}
      onPlay={() => onPlayAt(index)}
      style={{ position: 'absolute', insetInline: 0, top: 0, transform: `translateY(${y}px)` }}
    />
  )
})
