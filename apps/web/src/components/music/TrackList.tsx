import type { AlbumDisc, TrackSummary } from '@squirmy/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Clock3, Disc3, MoreHorizontal, Pause, Play } from 'lucide-react'
import { Fragment, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
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

/** What is playing, so the list can mark its row. `loading`: its music is on its way (a fetch looks like buffering). */
export type NowPlaying = { trackId: string; playing: boolean; loading: boolean; onTogglePlay: () => void }

/**
 * - `album`: track numbers, no artwork; for album pages.
 * - `playlist`: running numbers, artwork, album and (when the rows have `addedAt`) date added columns.
 * - `compact`: artwork instead of numbers, album column on wide screens; search and top tracks.
 */
export type TrackListVariant = 'album' | 'playlist' | 'compact'

type SharedProps = {
  variant?: TrackListVariant
  nowPlaying?: NowPlaying | null
  isWanted?: (track: TrackSummary) => boolean
  onPlay: (index: number) => void
  onAction?: (action: TrackAction, track: TrackSummary, index: number) => void
  /** Playlists the track menu offers to add to. */
  playlists?: PlaylistChoice[]
  /** Makes the rows reorderable by dragging and from the menu (a playlist the user owns). */
  onMove?: (from: number, to: number) => void
}

/**
 * A row is its own size container, and its columns follow its width rather than the window's: the
 * sidebar, the queue and a page's own columns all change how much room a list has. From 36rem an
 * album's artists and a compact row's album get a column; a playlist's album does from 42rem and
 * its date added from 56rem. The duration shows from 28rem.
 */
const columns: Record<TrackListVariant, string> = {
  album: 'grid-cols-[2rem_minmax(0,1fr)_auto] @xl:grid-cols-[2rem_minmax(0,5fr)_minmax(0,3fr)_auto]',
  playlist: 'grid-cols-[2rem_minmax(0,1fr)_auto] @2xl:grid-cols-[2rem_minmax(0,6fr)_minmax(0,4fr)_auto] @4xl:grid-cols-[2rem_minmax(0,6fr)_minmax(0,4fr)_7rem_auto]',
  compact: 'grid-cols-[minmax(0,1fr)_auto] @xl:grid-cols-[minmax(0,6fr)_minmax(0,4fr)_auto]',
}

/** A playlist's rows have a date added column only when they know the date. */
const columnsOf = (variant: TrackListVariant, dated: boolean) => (variant === 'playlist' && !dated ? undatedColumns : columns[variant])
const undatedColumns = 'grid-cols-[2rem_minmax(0,1fr)_auto] @2xl:grid-cols-[2rem_minmax(0,6fr)_minmax(0,4fr)_auto]'

/** The column a variant's rows give the album from the width that has room for it. */
const albumColumn = { album: undefined, playlist: 'hidden @2xl:block', compact: 'hidden @xl:block' } satisfies Record<TrackListVariant, string | undefined>

/**
 * The last column: like, duration, menu. The header's has the same width, so the columns between
 * line up with the rows'.
 */
const actionsColumn = 'flex items-center justify-end gap-1 @md:w-28'

/**
 * Controls that appear when their row is hovered, has the keyboard's focus anywhere in it or has
 * its menu open. Phones and touch screens, which cannot hover, always show them.
 */
const revealed = 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/row:opacity-100 md:pointer-fine:group-has-[:focus-visible]/row:opacity-100 md:pointer-fine:group-has-[[data-state=open]]/row:opacity-100'

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
export function TrackRow({ track, index, number, addedAt, variant = 'album', nowPlaying, wanted, onPlay, onAction, playlists, extraMenu, reorder, style }: TrackRowProps) {
  const navigate = useNavigate()
  const viewer = useViewer()
  const { liked } = track
  const unavailable = !isPlayable(track, viewer)
  const current = nowPlaying?.trackId === track.id
  const playing = current && nowPlaying.playing
  const loading = current && nowPlaying.loading
  const play = current ? nowPlaying.onTogglePlay : onPlay
  const act = (action: TrackAction) => onAction?.(action, track, index)

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
      aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
      onClick={play}
      className={cn(
        'peer absolute inset-0 flex items-center justify-center opacity-0 outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100',
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
  const resting = cn('pointer-events-none transition-opacity', !unavailable && 'group-hover/row:opacity-0 peer-focus-visible:opacity-0')

  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      <span title={track.title} className={cn('truncate text-sm font-medium', current && 'text-primary', unavailable && 'text-muted-foreground')}>{track.title}</span>
      {track.explicit && <ExplicitBadge />}
      {unavailable && <span className="sr-only">({UNAVAILABLE_LABEL})</span>}
    </div>
  )
  // Under the title, except on album pages, where a wide row gives the artists a column of their own.
  const artists = (
    <div className={cn('min-w-0 truncate text-xs text-muted-foreground', album && '@max-xl:col-start-2 @xl:text-sm')}>
      <ArtistLinks credit={track} plain={unavailable} />
    </div>
  )

  return (
    <ContextMenu entries={menu}>
      <li
        aria-current={current ? 'true' : undefined}
        // Playing is what is unavailable: the heart and the menu still work.
        aria-disabled={unavailable || undefined}
        title={unavailable ? UNAVAILABLE_LABEL : undefined}
        onDoubleClick={unavailable ? undefined : play}
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
          'group/row @container select-none rounded-md px-2 transition-colors',
          'data-[drop=after]:shadow-[inset_0_-2px_0_var(--primary)] data-[drop=before]:shadow-[inset_0_2px_0_var(--primary)]',
          unavailable ? 'text-muted-foreground' : 'hover:bg-accent/60 has-[:focus-visible]:bg-accent/60 has-[[data-state=open]]:bg-accent/60',
        )}
      >
        <div className={cn('grid h-11 content-center items-center gap-x-3', album && '@xl:h-10', columnsOf(variant, addedAt !== undefined), unavailable && '[&>*:not(:last-child)]:opacity-60')}>
          {variant === 'compact' ? null : (
            <div className={cn('relative flex h-8 items-center justify-center text-sm tabular text-muted-foreground', album && '@max-xl:row-span-2')}>
              {playButton(false)}
              <span className={resting}>{marker(false) ?? number ?? index + 1}</span>
            </div>
          )}

          {album ? title : (
            <div className="flex min-w-0 items-center gap-3">
              <div className="relative size-8 shrink-0">
                <Cover artwork={track.album?.artwork ?? null} size={96} dimmed={unavailable} className="size-8 rounded-[5px]" />
                {variant === 'compact' && (
                  <div className={cn('absolute inset-0 flex items-center justify-center rounded-[5px] transition-colors', current ? 'bg-black/50' : !unavailable && 'group-hover/row:bg-black/50 has-[:focus-visible]:bg-black/50')}>
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
          {album && artists}

          {albumColumn[variant] && (
            <div className={cn('min-w-0 truncate text-sm text-muted-foreground', albumColumn[variant])}>
              {track.album && <PrefetchLink kind="album" id={track.album.id} to={`/album/${track.album.id}`} className={cn('hover:underline', !unavailable && 'hover:text-foreground')}>{track.album.title}</PrefetchLink>}
            </div>
          )}
          {variant === 'playlist' && addedAt !== undefined && <div className="hidden truncate text-sm text-muted-foreground @4xl:block">{formatRelative(addedAt)}</div>}

          <div className={cn(actionsColumn, album && '@max-xl:col-start-3 @max-xl:row-span-2 @max-xl:row-start-1')}>
            {onAction && <SaveHeart liked={liked} onToggle={() => act('like')} title={track.title} tooltip={false} size="sm" className={cn(!liked && revealed)} />}
            <span className={cn('hidden w-10 text-right text-xs tabular text-muted-foreground @md:block', unavailable && 'opacity-60')}>{track.durationMs ? formatDuration(track.durationMs) : '–'}</span>
            <DropdownMenu
              entries={menu}
              trigger={(
                <IconButton label={`More options for ${track.title}`} tooltip={false} size="sm" className={revealed}>
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
    <div aria-hidden className="@container mb-1 border-b px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      <div className={cn('grid h-8 items-center gap-x-3', columnsOf(variant, dated))}>
        {variant !== 'compact' && <span className="text-center">#</span>}
        <span>Title</span>
        {variant === 'album' && <span className="hidden @xl:block">Artist</span>}
        {albumColumn[variant] && <span className={albumColumn[variant]}>Album</span>}
        {variant === 'playlist' && dated && <span className="hidden @4xl:block">Added</span>}
        {/* The clock sits over the durations, which end where the menu button starts. */}
        <span className={cn(actionsColumn, 'pr-9')}><Clock3 className="hidden size-3.5 @md:block" /></span>
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
            <TrackRow
              key={item.key}
              track={track}
              index={item.index}
              variant={variant}
              wanted={isWanted?.(track)}
              onPlay={() => onPlay(item.index)}
              style={{ position: 'absolute', insetInline: 0, top: 0, transform: `translateY(${item.start - margin}px)` }}
              {...rest}
            />
          )
        })}
      </ol>
    </div>
  )
}
