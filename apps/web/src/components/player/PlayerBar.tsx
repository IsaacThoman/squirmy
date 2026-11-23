import { Ellipsis, ListMusic, Maximize2, MessageSquareQuote, MonitorSpeaker, Music2 } from 'lucide-react'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { playingElsewhere, usePosition, whereItPlays, type Player } from '@/player/player-context'
import { STILL_LOADING_LABEL, useStillLoading } from '@/player/use-still-loading'
import { DevicesPopover, OnlyOnThisDevice, PlayingElsewhere } from './Devices'
import { PlayerStatusLine } from './PlayerStatus'
import { PlayPauseButton, SeekBar, touchTarget, TransportButtons, VolumeControl } from './Transport'

/** The bar is the sidebar's color, so what is hovered in it takes the sidebar's hover color. */
const barClass = '@container bg-sidebar text-sidebar-foreground [--accent:var(--sidebar-accent)]'

/** Bar widths, in px, below which the volume and the Now Playing button step into "More player controls". */
const VOLUME_FITS = 992
const NOW_PLAYING_FITS = 704
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
    const measure = () => setSize({ width: element.clientWidth || Infinity, short: short.matches })
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

/**
 * The desktop player, a row along the bottom of the shell: the track, the transport and the tools.
 * It lays itself out by its own width, which changes with the sidebar. Narrow (a tablet), the
 * transport goes on a row of its own under the song, so the title and credit stay readable;
 * the controls that do not fit go into "More player controls". While another device plays it
 * grows a row that says where. It keeps clear of the home indicator on a phone on its side.
 */
export function PlayerBar({ player, liked, onToggleLike, queueOpen, onToggleQueue, lyricsOpen, onToggleLyrics, onOpenNowPlaying }: PlayerChromeProps) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry, state.waiting)
  const [section, setSection] = useState<HTMLElement | null>(null)
  const { width, short } = useBarSize(section)
  const stacked = width < ONE_ROW_FITS && !short
  const volumeFits = width >= VOLUME_FITS
  const nowPlayingFits = width >= NOW_PLAYING_FITS
  // On one squeezed row (a phone on its side) lyrics step aside too; Now Playing has them.
  const lyricsFit = stacked || width >= ONE_ROW_FITS
  return (
    // A landmark, so screen readers can jump to the player and tests can find it by name.
    <section ref={setSection} aria-label="Player" className={cn(barClass, 'pb-[env(safe-area-inset-bottom)]')}>
      {/*
        Stacked: the song and the tools on top, the transport under them across the bar.
        A phone on its side keeps one row (there is no height to spare): the track takes what the
        transport and the tools leave. Wider: the transport is centered between equal sides.
      */}
      <div
        data-layout={stacked ? 'stacked' : 'row'}
        className={cn(
          'grid items-center border-t px-4',
          stacked
            ? 'grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 pb-2 pt-3'
            : 'h-[4.5rem] grid-cols-[minmax(0,1.3fr)_minmax(10rem,1fr)_auto] gap-3 @[36rem]:grid-cols-[minmax(0,1fr)_minmax(12rem,1.2fr)_auto] @[36rem]:gap-4 @[44rem]:grid-cols-[minmax(14rem,1fr)_minmax(0,36rem)_minmax(14rem,1fr)] @[62rem]:grid-cols-[minmax(17rem,1fr)_minmax(0,36rem)_minmax(17rem,1fr)]',
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {item ? (
            <>
              <button type="button" aria-label="Open Now Playing" onClick={onOpenNowPlaying} className="group relative shrink-0 rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar">
                <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-12 rounded-[5px]" />
                <span className="absolute inset-0 flex items-center justify-center rounded-[5px] bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 aria-hidden className="size-4" />
                </span>
              </button>
              <div className="min-w-0">
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
              {/* The heart stays at every width; the title is what gives way. It is named after the
                  song: the page beside it (an album, an artist) has a heart of its own. */}
              <SaveHeart liked={liked} onToggle={onToggleLike} title={item.track.title} size="sm" className={cn('ml-1 shrink-0', touchTarget)} />
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
        </div>

        <div className={cn('flex min-w-0 flex-col items-center gap-0.5', stacked && 'col-span-2 row-start-2')}>
          <TransportButtons player={player} disabled={!item} modeClassName={stacked || short ? undefined : 'hidden @[36rem]:inline-flex'} />
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
          {nowPlayingFits && <IconButton label="Now Playing" size="sm" disabled={!item} onClick={onOpenNowPlaying} className={touchTarget}><Maximize2 /></IconButton>}
          {!volumeFits && (
            <MoreControls>
              <VolumeControl volume={state.volume} deviceId={state.activeDeviceId ?? state.thisDeviceId} onChange={controls.setVolume} fill className="gap-2.5 px-1 py-1" />
              {!nowPlayingFits && (
                <button type="button" disabled={!item} onClick={onOpenNowPlaying} className={moreRowClass}>
                  <Maximize2 aria-hidden className="size-4 text-muted-foreground" />Now Playing
                </button>
              )}
              {!lyricsFit && (
                <button type="button" disabled={!item} onClick={onToggleLyrics} className={moreRowClass}>
                  <MessageSquareQuote aria-hidden className="size-4 text-muted-foreground" />{lyricsOpen ? 'Hide lyrics' : 'Lyrics'}
                </button>
              )}
            </MoreControls>
          )}
        </div>
      </div>
      {/* One strip at a time: a detached tab is never controlling another device. */}
      {elsewhere
        ? <PlayingElsewhere player={player} device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} onPrepare={controls.prepareHere} className="border-t" />
        : state.detached && <OnlyOnThisDevice player={player} className="border-t" />}
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
      <PopoverContent side="top" align="end" aria-label="More player controls" className="w-64 p-1">
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
    <section aria-label="Player" className={cn(barClass, 'relative pb-[env(safe-area-inset-bottom)]')}>
      <div className="flex h-16 items-center gap-1 border-t pl-3 pr-2">
        <button type="button" aria-label={`Open Now Playing, ${item.track.title}`} onClick={onOpenNowPlaying} className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-10 rounded-[5px]" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{item.track.title}</span>
            <span className={cn('block truncate text-xs', elsewhere || state.detached ? 'text-primary' : 'text-muted-foreground')}>
              {elsewhere ? whereItPlays(state, elsewhere) : state.detached ? 'Only on this device' : late ? STILL_LOADING_LABEL : item.track.artistCredit}
            </span>
          </span>
        </button>
        {devices}
        {/* A 40px disc whose touch target is 44px. */}
        <PlayPauseButton playing={state.playing} loading={state.waiting} onClick={controls.togglePlay} className="mx-1 size-10 after:absolute after:-inset-0.5 after:rounded-full [&_svg]:size-5" />
      </div>
      {/* Outside the button, which names only the song. */}
      <PlayerStatusLine status={state.status} className="-mt-2 pb-1.5 pl-16 pr-3" />
      <MiniProgress durationMs={item.entry.durationMs} />
    </section>
  )
}

/** How far the track is, drawn over the bar's top border. */
function MiniProgress({ durationMs }: { durationMs: number }) {
  const position = usePosition()
  return (
    <div aria-hidden className="absolute inset-x-0 top-0 h-0.5">
      <div className="h-full bg-primary" style={{ width: `${Math.min(100, (position / Math.max(durationMs, 1)) * 100)}%` }} />
    </div>
  )
}
