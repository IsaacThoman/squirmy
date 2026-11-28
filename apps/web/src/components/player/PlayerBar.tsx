import { ChevronUp, Ellipsis, Heart, ListMusic, ListStart, MessageSquareQuote, MonitorSpeaker, Music2, PictureInPicture2 } from 'lucide-react'
import { useLayoutEffect, useState, type DragEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { errorMessage } from '@/api/errors'
import { songsLabel } from '@/components/music/track-menu'
import { draggedMusic } from '@/lib/drag'
import { cn } from '@/lib/utils'
import { useDroppedMusic } from '@/player/use-dropped-music'
import { playingElsewhere, usePosition, type Player } from '@/player/player-context'
import { STILL_LOADING_LABEL, useStillLoading } from '@/player/use-still-loading'
import { DevicesPopover } from './Devices'
import { PlayerStatusLine } from './PlayerStatus'
import { SongContextMenu } from './SongMenu'
import { progressPosition } from './progress'
import { PlayPauseButton, SeekBar, touchTarget, TransportButtons, VolumeControl } from './Transport'
import { useNowPlayingWheel } from './use-now-playing-wheel'

/** The bar is the sidebar's color, so what is hovered in it takes the sidebar's hover color. */
const barClass = '@container bg-sidebar text-sidebar-foreground [--accent:var(--sidebar-accent)]'

/** Bar widths, in px, below which the volume and the Now Playing button step into "More player controls". */
const VOLUME_FITS = 992
const NOW_PLAYING_FITS = 704
/** Pop out player gets a button of its own past this width, beside the volume; below, it is under More. */
const POP_OUT_FITS = 1120
/** Below this the bar stacks the transport under the song, so the title and credit keep their room. */
const ONE_ROW_FITS = 576

export type PlayerChromeProps = {
  player: Player
  liked: boolean
  onToggleLike: () => void
  queueOpen: boolean
  onToggleQueue: () => void
  lyricsOpen: boolean
  onToggleLyrics: () => void
  onOpenNowPlaying: () => void
  /** Pops the player out into a window of its own; left out where the browser cannot. */
  onTogglePopOut?: () => void
  poppedOut?: boolean
}

/**
 * The bar's width, and whether the window is a phone on its side (too short to stack the bar).
 * Before it is measured (or where nothing measures, as in tests) the bar counts as wide.
 */
function useBarSize(element: HTMLElement | null) {
  const [size, setSize] = useState({ width: Infinity, short: false })
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const short = window.matchMedia('(orientation: landscape) and (max-height: 32rem)')
    // The bar resizes on every frame of the sidebar's fold; it renders again only when that changes what fits.
    const measure = () => {
      const next = { width: element.clientWidth || Infinity, short: short.matches }
      setSize(size => (sameFit(size.width, next.width) && size.short === next.short ? size : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    short.addEventListener('change', measure)
    return () => {
      observer.disconnect()
      short.removeEventListener('change', measure)
    }
  }, [element])
  return size
}

/** Whether two bar widths fit the same controls: on the same side of every width the bar lays itself out by. */
function sameFit(a: number, b: number) {
  return [ONE_ROW_FITS, NOW_PLAYING_FITS, VOLUME_FITS, POP_OUT_FITS].every(fits => (a >= fits) === (b >= fits))
}

/**
 * The desktop player, a row along the bottom of the shell: the track, the transport and the tools.
 * It lays itself out by its own width, which changes with the sidebar. Narrow (a tablet), the
 * transport goes on a row of its own under the song, so the title and credit stay readable;
 * the controls that do not fit go into "More player controls". It keeps clear of the home
 * indicator on a phone on its side.
 */
/**
 * Songs or a card dropped on the player play next: the bar says so while they are over it, and
 * the status line once they are in.
 */
function usePlayNextDrop(player: PlayerChromeProps['player']) {
  const songsOf = useDroppedMusic()
  const [over, setOver] = useState(false)
  const handlers = {
    onDragOver: (event: DragEvent) => {
      if (!draggedMusic(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false)
    },
    onDrop: (event: DragEvent) => {
      const music = draggedMusic(event)
      setOver(false)
      if (!music) return
      event.preventDefault()
      songsOf(music).then(
        tracks => {
          player.controls.enqueue(tracks, 'next')
          player.controls.tell({ message: 'Playing next', detail: music.kind === 'collection' ? music.collection.title : songsLabel(tracks.length), tone: 'info' })
        },
        (error: unknown) => player.controls.tell({ message: 'Couldn’t add to the queue', detail: errorMessage(error), tone: 'error' }),
      )
    },
  }
  return { over, handlers }
}

export function PlayerBar({ player, liked, onToggleLike, queueOpen, onToggleQueue, lyricsOpen, onToggleLyrics, onOpenNowPlaying, onTogglePopOut, poppedOut = false }: PlayerChromeProps) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry, state.waiting)
  const [section, setSection] = useState<HTMLElement | null>(null)
  const { width, short } = useBarSize(section)
  const stacked = width < ONE_ROW_FITS && !short
  const volumeFits = width >= VOLUME_FITS
  const nowPlayingFits = width >= NOW_PLAYING_FITS
  const popOutFits = width >= POP_OUT_FITS
  // On one squeezed row (a phone on its side) lyrics and the heart step aside too, so the title
  // keeps some room: they are behind More, and Now Playing has them.
  const lyricsFit = stacked || width >= ONE_ROW_FITS
  const heartFits = lyricsFit
  const onWheel = useNowPlayingWheel('up', onOpenNowPlaying)
  const drop = usePlayNextDrop(player)
  const popOutButton = onTogglePopOut && (
    <IconButton label={poppedOut ? 'Close pop-out player' : 'Pop out player'} size="sm" pressed={poppedOut} onClick={onTogglePopOut} className={touchTarget}><PictureInPicture2 /></IconButton>
  )
  const song = (children: ReactNode) => (item ? <SongContextMenu track={item.track}>{children}</SongContextMenu> : children)
  return (
    // A landmark, so screen readers can jump to the player and tests can find it by name.
    <section ref={setSection} aria-label="Player" data-drop-target="" className={cn(barClass, 'relative pb-[env(safe-area-inset-bottom)]')} onWheel={item ? onWheel : undefined} {...drop.handlers}>
      {drop.over && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 border-t bg-sidebar/90 text-sm font-medium ring-2 ring-inset ring-primary">
          <ListStart className="size-4 text-primary" />Drop to play next
        </div>
      )}
      {/*
        Stacked: the song and the tools on top, the transport under them across the bar.
        A phone on its side keeps one row (there is no height to spare): the track takes what the
        transport and the tools leave. Wider: the transport is centered between equal sides. On a touch
        screen the transport and the seek bar are each a finger's 44 px tall, so the bar is taller.
      */}
      <div
        data-layout={stacked ? 'stacked' : 'row'}
        className={cn(
          'grid items-center border-t px-4',
          stacked
            ? 'grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 pb-2 pt-3'
            : 'h-[4.5rem] pointer-coarse:h-[5.75rem] grid-cols-[minmax(0,1.3fr)_minmax(10rem,1fr)_auto] gap-3 @[36rem]:grid-cols-[minmax(0,1fr)_minmax(12rem,1.2fr)_auto] @[36rem]:gap-4 @[44rem]:grid-cols-[minmax(14rem,1fr)_minmax(0,36rem)_minmax(14rem,1fr)] @[62rem]:grid-cols-[minmax(17rem,1fr)_minmax(0,36rem)_minmax(17rem,1fr)]',
        )}
      >
        {song(<div className="flex min-w-0 items-center gap-3">
          {item ? (
            <>
              <button type="button" aria-label="Open Now Playing" onClick={onOpenNowPlaying} className="group relative shrink-0 rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar">
                <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-12 rounded-[5px]" />
                <span className="absolute inset-0 flex items-center justify-center rounded-[5px] bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <ChevronUp aria-hidden className="size-4" />
                </span>
              </button>
              {/* Two lines of words, too close for 44 px each; on a touch screen the cover opens Now Playing (`data-inline-links`). */}
              <div data-inline-links className="min-w-0">
                {item.track.album
                  ? <Link to={`/album/${item.track.album.id}`} title={item.track.title} className="block truncate text-sm font-medium hover:underline">{item.track.title}</Link>
                  : <p title={item.track.title} className="truncate text-sm font-medium">{item.track.title}</p>}
                {/* A credit too long for the bar shows whole on hover; each artist in it stays a link. */}
                <p data-credit="" title={late ? undefined : item.track.artistCredit} className="truncate text-xs text-muted-foreground">
                  {late
                    ? STILL_LOADING_LABEL
                    : <ArtistLinks credit={item.track} />}
                </p>
                <PlayerStatusLine status={state.status} />
              </div>
              {/* The heart is named after the song: the page beside it (an album, an artist) has a heart of its own. */}
              {heartFits && <SaveHeart id={item.track.id} liked={liked} onToggle={onToggleLike} title={item.track.title} size="sm" className={cn('ml-1 shrink-0', touchTarget)} />}
            </>
          ) : (
            <>
              <div aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[5px] bg-muted text-muted-foreground/70 ring-1 ring-inset ring-foreground/5">
                <Music2 className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm text-muted-foreground">Nothing playing</p>
                <PlayerStatusLine status={state.status} />
              </div>
            </>
          )}
        </div>)}

        <div className={cn('flex min-w-0 flex-col items-center gap-0.5', stacked && 'col-span-2 row-start-2')}>
          <TransportButtons player={player} disabled={!item} modeClassName={stacked ? undefined : 'hidden @[36rem]:inline-flex'} />
          <SeekBar durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} />
        </div>

        <div className={cn('flex min-w-0 items-center justify-end gap-1', stacked && 'col-start-2 row-start-1')}>
          {lyricsFit && <IconButton label={lyricsOpen ? 'Hide lyrics' : 'Lyrics'} size="sm" pressed={lyricsOpen} disabled={!item} onClick={onToggleLyrics} className={touchTarget}><MessageSquareQuote /></IconButton>}
          <IconButton label={queueOpen ? 'Hide queue' : 'Queue'} size="sm" pressed={queueOpen} onClick={onToggleQueue} aria-expanded={queueOpen} data-queue-toggle="" className={touchTarget}><ListMusic /></IconButton>
          <DevicesPopover
            player={player}
            trigger={<IconButton label="Devices" size="sm" className={cn(touchTarget, (elsewhere || state.detached) && 'text-primary hover:text-primary')}><MonitorSpeaker /></IconButton>}
          />
          {volumeFits && <VolumeControl volume={state.volume} deviceId={state.activeDeviceId ?? state.thisDeviceId} onChange={controls.setVolume} />}
          {popOutFits && popOutButton}
          {nowPlayingFits && <IconButton label="Now Playing" size="sm" disabled={!item} onClick={onOpenNowPlaying} className={touchTarget}><ChevronUp /></IconButton>}
          {(!volumeFits || (onTogglePopOut && !popOutFits)) && (
            <MoreControls>
              {!volumeFits && <VolumeControl volume={state.volume} deviceId={state.activeDeviceId ?? state.thisDeviceId} onChange={controls.setVolume} fill className="gap-2.5 px-1 py-1" />}
              {!nowPlayingFits && (
                <button type="button" disabled={!item} onClick={onOpenNowPlaying} className={moreRowClass}>
                  <ChevronUp aria-hidden className="size-4 text-muted-foreground" />Now Playing
                </button>
              )}
              {!popOutFits && onTogglePopOut && (
                <button type="button" aria-pressed={poppedOut} onClick={onTogglePopOut} className={moreRowClass}>
                  <PictureInPicture2 aria-hidden className={cn('size-4', poppedOut ? 'text-primary' : 'text-muted-foreground')} />{poppedOut ? 'Close pop-out player' : 'Pop out player'}
                </button>
              )}
              {!lyricsFit && (
                <button type="button" disabled={!item} onClick={onToggleLyrics} className={moreRowClass}>
                  <MessageSquareQuote aria-hidden className="size-4 text-muted-foreground" />{lyricsOpen ? 'Hide lyrics' : 'Lyrics'}
                </button>
              )}
              {!heartFits && item && (
                <button type="button" aria-pressed={liked} onClick={onToggleLike} className={moreRowClass}>
                  <Heart aria-hidden className={cn('size-4', liked ? 'fill-current text-primary' : 'text-muted-foreground')} />{liked ? 'Remove from library' : 'Save to library'}
                </button>
              )}
            </MoreControls>
          )}
        </div>
      </div>
    </section>
  )
}

const moreRowClass = 'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11'

/** The controls a narrow bar has no room for, behind one button. */
function MoreControls({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="More player controls" size="sm" className={touchTarget}><Ellipsis /></IconButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-label="More player controls"
        className="w-64 p-1"
        // Focus goes to the popover, not to its first button, as in Devices: that would raise the mute button's tooltip.
        onOpenAutoFocus={event => {
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The phone's player, a row along the bottom of the shell. Tapping it opens Now Playing. With
 * nothing to play it still shows, so where the first song will play can be chosen.
 */
export function MiniPlayer({ player, onOpenNowPlaying }: Pick<PlayerChromeProps, 'player' | 'onOpenNowPlaying'>) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry, state.waiting)
  const onWheel = useNowPlayingWheel('up', onOpenNowPlaying)
  const devices = (
    <DevicesPopover
      player={player}
      trigger={<IconButton label="Devices" tooltip={false} size="lg" className={cn('size-11', (elsewhere || state.detached) && 'text-primary hover:text-primary')}><MonitorSpeaker /></IconButton>}
    />
  )
  if (!item) {
    return (
      <section aria-label="Player" className={cn(barClass, 'pb-[env(safe-area-inset-bottom)]')}>
        <div className="flex h-14 items-center gap-3 border-t pl-3 pr-2">
          <div aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[5px] bg-muted text-muted-foreground/70 ring-1 ring-inset ring-foreground/5">
            <Music2 className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-muted-foreground">Nothing playing</p>
            <PlayerStatusLine status={state.status} />
          </div>
          {devices}
        </div>
      </section>
    )
  }
  return (
    <section aria-label="Player" className={cn(barClass, 'relative pb-[env(safe-area-inset-bottom)]')} onWheel={onWheel}>
      <div className="flex h-16 items-center gap-1 border-t pl-3 pr-2">
        <button type="button" aria-label={`Open Now Playing, ${item.track.title}`} onClick={onOpenNowPlaying} className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-10 rounded-[5px]" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{item.track.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {late ? STILL_LOADING_LABEL : item.track.artistCredit}
            </span>
          </span>
        </button>
        {devices}
        {/* A 40px disc whose touch target is 44px (the icon button's own). */}
        <PlayPauseButton playing={state.playing} loading={state.waiting} onClick={controls.togglePlay} className="mx-1 size-10 [&_svg]:size-5" />
      </div>
      {/* Outside the button, which names only the song. */}
      <PlayerStatusLine status={state.status} className="-mt-2 pb-1.5 pl-16 pr-3" />
      <MiniProgress durationMs={item.entry.durationMs} />
    </section>
  )
}

/** How far the track is, drawn over the bar's top border. */
function MiniProgress({ durationMs }: { durationMs: number }) {
  const position = usePosition(positionMs => progressPosition(positionMs, durationMs))
  // Scaled rather than sized: a transform moves without laying the bar out again on every step.
  return (
    <div aria-hidden className="absolute inset-x-0 top-0 h-0.5">
      <div className="h-full origin-left bg-primary" style={{ transform: `scaleX(${Math.min(1, Math.max(0, position / Math.max(durationMs, 1)))})` }} />
    </div>
  )
}
