import type { AlbumDisc, TrackSummary } from '@squirmy/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  BookmarkCheck, BookmarkPlus, Clock3, CloudDownload, Disc3, Heart, ListEnd, ListStart, MicVocal, MoreHorizontal, Pause, Play, Trash2,
} from 'lucide-react'
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router'
import { useScrollContainer } from '@/components/layout/scroll-context'
import { ExplicitBadge, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { Tooltip } from '@/components/ui/tooltip'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Cover } from './Cover'
import { Equalizer } from './Equalizer'

export type TrackAction = 'play-next' | 'enqueue' | 'like' | 'want' | 'remove'

/** What is playing, so the list can mark its row. */
export type NowPlaying = { trackId: string; playing: boolean; preparing: boolean; onTogglePlay: () => void }

/**
 * - `album`: track numbers, no artwork; for album pages.
 * - `playlist`: running numbers, artwork, album and date added columns.
 * - `compact`: artwork instead of numbers, album column on wide screens; search and top tracks.
 */
export type TrackListVariant = 'album' | 'playlist' | 'compact'

type SharedProps = {
  variant?: TrackListVariant
  nowPlaying?: NowPlaying | null
  isLiked?: (track: TrackSummary) => boolean
  isWanted?: (track: TrackSummary) => boolean
  onPlay: (index: number) => void
  onAction?: (action: TrackAction, track: TrackSummary, index: number) => void
}

const columns: Record<TrackListVariant, string> = {
  album: 'grid-cols-[2.25rem_minmax(0,1fr)_auto]',
  playlist: 'grid-cols-[2.25rem_minmax(0,1fr)_auto] md:grid-cols-[2.25rem_minmax(0,6fr)_minmax(0,4fr)_auto] xl:grid-cols-[2.25rem_minmax(0,6fr)_minmax(0,4fr)_7rem_auto]',
  compact: 'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,6fr)_minmax(0,4fr)_auto]',
}

type TrackRowProps = Omit<SharedProps, 'onPlay' | 'isLiked' | 'isWanted'> & {
  track: TrackSummary
  index: number
  /** The number in the first column; defaults to the row's position. */
  number?: number
  addedAt?: string
  liked?: boolean
  wanted?: boolean
  onPlay: () => void
  /** Owners such as the queue add their own entries to the menu. */
  extraMenu?: MenuEntry[]
  style?: CSSProperties
}

export function TrackRow({ track, index, number, addedAt, variant = 'album', nowPlaying, liked = track.liked, wanted = false, onPlay, onAction, extraMenu, style }: TrackRowProps) {
  const navigate = useNavigate()
  const unavailable = track.availability === 'none'
  const current = nowPlaying?.trackId === track.id
  const playing = current && nowPlaying.playing
  const preparing = current && nowPlaying.preparing
  const play = current ? nowPlaying.onTogglePlay : onPlay
  const act = (action: TrackAction) => onAction?.(action, track, index)

  const menu: MenuEntry[] = [
    { label: 'Play next', icon: <ListStart />, onSelect: () => act('play-next'), disabled: unavailable },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => act('enqueue'), disabled: unavailable },
    { kind: 'separator' },
    { label: liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: <Heart />, onSelect: () => act('like') },
    ...(track.availability === 'server' ? [] : [{ label: wanted ? 'Remove from Wantlist' : 'Add to Wantlist', icon: wanted ? <BookmarkCheck /> : <BookmarkPlus />, onSelect: () => act('want') }]),
    { kind: 'separator' },
    ...(track.album ? [{ label: 'Go to album', icon: <Disc3 />, onSelect: () => navigate(`/album/${track.album!.id}`) }] : []),
    ...track.artists.map(artist => ({ label: track.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
    ...(extraMenu ?? []),
    ...(variant === 'playlist' && onAction ? [{ kind: 'separator' as const }, { label: 'Remove from playlist', icon: <Trash2 />, danger: true, onSelect: () => act('remove') }] : []),
  ]

  const playButton = !unavailable && (
    <button
      type="button"
      aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
      onClick={play}
      className="absolute inset-0 flex items-center justify-center rounded-md text-foreground opacity-0 transition-opacity duration-100 focus-visible:opacity-100 group-hover/row:opacity-100"
    >
      {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4" fill="currentColor" />}
    </button>
  )

  const marker = preparing
    ? <Spinner label="Preparing" className="size-4" />
    : current ? <Equalizer playing={playing} /> : null

  return (
    <ContextMenu entries={menu}>
      <li
        aria-current={current ? 'true' : undefined}
        aria-disabled={unavailable || undefined}
        title={unavailable ? 'Not in your library' : undefined}
        onDoubleClick={unavailable ? undefined : play}
        style={style}
        className={cn(
          'group/row grid h-14 select-none items-center gap-3 rounded-lg px-2 transition-colors duration-100',
          columns[variant],
          unavailable ? 'text-quiet [&>*:not(:last-child)]:opacity-60' : 'hover:bg-overlay has-[[data-state=open]]:bg-overlay',
          current && 'bg-selection hover:bg-selection',
        )}
      >
        {variant === 'compact' ? null : (
          <div className="relative flex h-8 items-center justify-center text-[15px] tabular text-quiet">
            <span className={cn('transition-opacity duration-100', !unavailable && 'group-hover/row:opacity-0', current && 'text-accent')}>
              {marker ?? number ?? index + 1}
            </span>
            {playButton}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-3">
          {(variant === 'compact' || variant === 'playlist') && (
            <div className="relative size-10 shrink-0">
              <Cover artwork={track.album?.artwork ?? null} size={96} dimmed={unavailable} className="size-10 rounded-md" />
              {variant === 'compact' && (
                <div className={cn('absolute inset-0 flex items-center justify-center rounded-md', (current || preparing) && 'bg-black/45 text-white')}>
                  {marker && <span className={cn('transition-opacity', !unavailable && 'group-hover/row:opacity-0')}>{marker}</span>}
                  {playButton && <div className="absolute inset-0 rounded-md text-white group-hover/row:bg-black/45 [&_button]:text-white">{playButton}</div>}
                </div>
              )}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={cn('truncate text-[15px] font-medium tracking-[-0.01em]', current && 'text-accent', unavailable && 'text-quiet')}>{track.title}</span>
              {track.availability === 'on_demand' && (
                <Tooltip label="Plays on demand">
                  <CloudDownload tabIndex={0} aria-label="Plays on demand" className="size-3.5 shrink-0 text-quiet outline-none focus-visible:text-accent" />
                </Tooltip>
              )}
              {unavailable && <span className="sr-only">(not in your library)</span>}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-muted">
              {track.explicit && <ExplicitBadge />}
              {preparing ? <span className="text-accent">Preparing…</span> : <ArtistLinks track={track} dimmed={unavailable} />}
            </div>
          </div>
        </div>

        {(variant === 'playlist' || variant === 'compact') && (
          <div className={cn('hidden min-w-0 truncate text-[13px] text-muted', variant === 'playlist' ? 'md:block' : 'lg:block', unavailable && 'text-quiet')}>
            {track.album && <Link to={`/album/${track.album.id}`} className="hover:text-foreground hover:underline">{track.album.title}</Link>}
          </div>
        )}
        {variant === 'playlist' && <div className="hidden truncate text-[13px] text-muted xl:block">{addedAt && formatRelative(addedAt)}</div>}

        <div className="flex items-center justify-end gap-1">
          {onAction && (
            <IconButton
              label={liked ? `Remove ${track.title} from Liked Songs` : `Save ${track.title} to Liked Songs`}
              tooltip={false}
              size="sm"
              onClick={() => act('like')}
              className={cn(liked ? 'text-accent hover:text-accent' : 'md:opacity-0 md:focus-visible:opacity-100 md:group-hover/row:opacity-100')}
            >
              <Heart fill={liked ? 'currentColor' : 'none'} />
            </IconButton>
          )}
          <span className="hidden w-11 text-right text-[13px] tabular text-quiet sm:block">{track.durationMs ? formatDuration(track.durationMs) : '–'}</span>
          <DropdownMenu
            entries={menu}
            trigger={(
              <IconButton label={`More options for ${track.title}`} tooltip={false} size="sm" className="md:opacity-0 md:focus-visible:opacity-100 md:group-hover/row:opacity-100 data-[state=open]:opacity-100">
                <MoreHorizontal />
              </IconButton>
            )}
          />
        </div>
      </li>
    </ContextMenu>
  )
}

function ArtistLinks({ track, dimmed }: { track: TrackSummary; dimmed: boolean }) {
  if (!track.artists.length) return <span className="truncate">{track.artistCredit}</span>
  return (
    <span className="truncate">
      {track.artists.map((artist, index) => (
        <Fragment key={artist.id}>
          {index > 0 && ', '}
          <Link to={`/artist/${artist.id}`} className={cn('hover:underline', dimmed ? 'text-quiet' : 'hover:text-foreground')}>{artist.name}</Link>
        </Fragment>
      ))}
    </span>
  )
}

function ListHeader({ variant }: { variant: TrackListVariant }) {
  if (variant === 'compact') return null
  return (
    <div aria-hidden className={cn('mb-1 grid h-9 items-center gap-3 border-b border-stroke px-2 text-xs font-semibold uppercase tracking-wider text-quiet', columns[variant])}>
      <span className="text-center">#</span>
      <span>Title</span>
      {variant === 'playlist' && <span className="hidden md:block">Album</span>}
      {variant === 'playlist' && <span className="hidden xl:block">Added</span>}
      <span className="flex justify-end pr-11"><Clock3 className="hidden size-4 sm:block" /></span>
    </div>
  )
}

export function DiscHeader({ disc, title }: { disc: number; title: string | null }) {
  return (
    <li className="flex h-12 items-center gap-3 px-2 pt-3 text-sm font-semibold text-muted first:pt-0">
      <Disc3 aria-hidden className="size-4 text-quiet" />
      <span>Disc {disc}{title && <span className="font-normal text-quiet"> · {title}</span>}</span>
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

export function TrackList({ tracks, discs, addedAt, header = true, label, variant = 'album', isLiked, isWanted, onPlay, ...rest }: TrackListProps) {
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
      liked={isLiked ? isLiked(track) : track.liked}
      wanted={isWanted?.(track)}
      onPlay={() => onPlay(start + i)}
      {...rest}
    />
  ))
  return (
    <div>
      {header && <ListHeader variant={variant} />}
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

const rowHeight = 56

/** The same rows, rendered only near the viewport. For the whole library's songs. */
export function VirtualTrackList({ tracks, label, variant = 'compact', isLiked, isWanted, onPlay, ...rest }: Omit<TrackListProps, 'discs' | 'addedAt' | 'header'>) {
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
  })

  return (
    <div>
      <ListHeader variant={variant} />
      <ol ref={list} aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const track = tracks[item.index]
          return (
            <TrackRow
              key={item.key}
              track={track}
              index={item.index}
              variant={variant}
              liked={isLiked ? isLiked(track) : track.liked}
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
