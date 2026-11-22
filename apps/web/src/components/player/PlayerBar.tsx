import { ListMusic, Maximize2, MessageSquareQuote, MonitorSpeaker, Music2 } from 'lucide-react'
import { Link } from 'react-router'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { playingElsewhere, usePosition, whereItPlays, type Player } from '@/player/player-context'
import { STILL_LOADING_LABEL, useStillLoading } from '@/player/use-still-loading'
import { DevicesPopover, OnlyOnThisDevice, PlayingElsewhere } from './Devices'
import { PlayPauseButton, SeekBar, touchTarget, TransportButtons, VolumeControl } from './Transport'

/** The bar is the sidebar's color, so what is hovered in it takes the sidebar's hover color. */
const barClass = '@container bg-sidebar text-sidebar-foreground [--accent:var(--sidebar-accent)]'

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
 * The desktop player, a row along the bottom of the shell: the track, the transport and the tools.
 * It lays itself out by its own width, which changes with the sidebar. While another device plays
 * it grows a second row that says where.
 */
export function PlayerBar({ player, liked, onToggleLike, queueOpen, onToggleQueue, lyricsOpen, onToggleLyrics, onOpenNowPlaying }: PlayerChromeProps) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry, state.waiting)
  return (
    // A landmark, so screen readers can jump to the player and tests can find it by name.
    <section aria-label="Player" className={barClass}>
      {/*
        Narrow: the track takes what the transport and the tools leave, and below 36rem shuffle, repeat
        and lyrics step aside (the queue and Now Playing have them) so the title stays readable.
        Wider: the transport is centered between equal sides.
      */}
      <div className="grid h-[4.5rem] grid-cols-[minmax(0,1.3fr)_minmax(10rem,1fr)_auto] items-center gap-3 border-t px-4 @[36rem]:grid-cols-[minmax(0,1fr)_minmax(12rem,1.2fr)_auto] @[36rem]:gap-4 @[44rem]:grid-cols-[minmax(14rem,1fr)_minmax(0,36rem)_minmax(14rem,1fr)] @[62rem]:grid-cols-[minmax(17rem,1fr)_minmax(0,36rem)_minmax(17rem,1fr)]">
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
                <p className="truncate text-xs text-muted-foreground">
                  {late
                    ? STILL_LOADING_LABEL
                    : <ArtistLinks credit={item.track} />}
                </p>
              </div>
              <SaveHeart liked={liked} onToggle={onToggleLike} size="sm" className={cn('ml-1 hidden @[44rem]:inline-flex', touchTarget)} />
            </>
          ) : (
            <>
              <div aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[5px] bg-muted text-muted-foreground/70 ring-1 ring-inset ring-foreground/5">
                <Music2 className="size-5" />
              </div>
              <p className="truncate text-sm text-muted-foreground">Nothing playing</p>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col items-center gap-0.5">
          <TransportButtons player={player} disabled={!item} modeClassName="hidden @[36rem]:inline-flex" />
          <SeekBar durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} />
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
          <IconButton label={lyricsOpen ? 'Hide lyrics' : 'Lyrics'} size="sm" pressed={lyricsOpen} disabled={!item} onClick={onToggleLyrics} className={cn('hidden @[36rem]:inline-flex', touchTarget)}><MessageSquareQuote /></IconButton>
          <IconButton label={queueOpen ? 'Hide queue' : 'Queue'} size="sm" pressed={queueOpen} onClick={onToggleQueue} className={touchTarget}><ListMusic /></IconButton>
          <DevicesPopover
            player={player}
            trigger={<IconButton label="Devices" size="sm" className={cn(touchTarget, (elsewhere || state.detached) && 'text-primary hover:text-primary')}><MonitorSpeaker /></IconButton>}
          />
          <VolumeControl volume={state.volume} deviceId={state.activeDeviceId ?? state.thisDeviceId} onChange={controls.setVolume} className="hidden @[62rem]:flex" />
          <IconButton label="Now Playing" size="sm" disabled={!item} onClick={onOpenNowPlaying} className={cn('hidden @[44rem]:inline-flex', touchTarget)}><Maximize2 /></IconButton>
        </div>
      </div>
      {/* One strip at a time: a detached tab is never controlling another device. */}
      {elsewhere
        ? <PlayingElsewhere player={player} device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} onPrepare={controls.prepareHere} className="border-t" />
        : state.detached && <OnlyOnThisDevice player={player} className="border-t" />}
    </section>
  )
}

/** The phone's player, a row along the bottom of the shell. Tapping it opens Now Playing. */
export function MiniPlayer({ player, onOpenNowPlaying }: Pick<PlayerChromeProps, 'player' | 'onOpenNowPlaying'>) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry, state.waiting)
  if (!item) return null
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
        <DevicesPopover
          player={player}
          trigger={<IconButton label="Devices" tooltip={false} size="lg" className={cn('size-11', (elsewhere || state.detached) && 'text-primary hover:text-primary')}><MonitorSpeaker /></IconButton>}
        />
        {/* A 40px disc whose touch target is 44px. */}
        <PlayPauseButton playing={state.playing} loading={state.waiting} onClick={controls.togglePlay} className="mx-1 size-10 after:absolute after:-inset-0.5 after:rounded-full [&_svg]:size-5" />
      </div>
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
