import { Heart, ListMusic, Maximize2, MonitorSpeaker, Music2, Pause, Play, Quote } from 'lucide-react'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { playingElsewhere, usePosition, type Player } from '@/player/player-context'
import { DevicesPopover, PlayingElsewhere } from './Devices'
import { SeekBar, TransportButtons, VolumeControl } from './Transport'

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

/** The shared playback controls at the bottom of the desktop workspace. */
export function PlayerBar({ player, liked, onToggleLike, queueOpen, onToggleQueue, lyricsOpen, onToggleLyrics, onOpenNowPlaying }: PlayerChromeProps) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  return (
    <section aria-label="Player" className="border-t border-stroke bg-sheet">
      <div className="grid h-[5.3125rem] grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,1fr)] items-center gap-3 px-4 lg:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {item ? (
            <>
              <button type="button" aria-label="Open Now Playing" onClick={onOpenNowPlaying} className="group relative shrink-0 rounded-lg">
                <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-12 rounded-lg" />
                <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 className="size-4" />
                </span>
              </button>
              <div className="min-w-0">
                {item.track.album
                  ? <Link to={`/album/${item.track.album.id}`} title={item.track.title} className="block truncate text-sm font-semibold hover:underline">{item.track.title}</Link>
                  : <p title={item.track.title} className="truncate text-sm font-semibold">{item.track.title}</p>}
                <p className="truncate text-xs text-muted">
                  {item.entry.state === 'preparing'
                    ? <span className="text-accent">Preparing…</span>
                    : item.track.artists[0]
                      ? <Link to={`/artist/${item.track.artists[0].id}`} className="hover:text-foreground hover:underline">{item.track.artistCredit}</Link>
                      : item.track.artistCredit}
                </p>
              </div>
              <IconButton label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'} size="sm" onClick={onToggleLike} className={cn('shrink-0', liked && 'text-accent hover:text-accent')}>
                <Heart fill={liked ? 'currentColor' : 'none'} />
              </IconButton>
            </>
          ) : (
            <>
              <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-lg border border-stroke bg-surface text-quiet"><Music2 className="size-[18px]" /></span>
              <p className="truncate text-[13px] font-medium text-muted">Nothing playing</p>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col items-center gap-0.5">
          <TransportButtons player={player} disabled={!item} />
          <SeekBar durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} className="max-w-[34rem]" />
        </div>

        <div className="flex items-center justify-end gap-0.5">
          <IconButton label={lyricsOpen ? 'Hide lyrics' : 'Lyrics'} size="sm" pressed={lyricsOpen} disabled={!item} onClick={onToggleLyrics}><Quote /></IconButton>
          <IconButton label={queueOpen ? 'Hide queue' : 'Queue'} size="sm" pressed={queueOpen} onClick={onToggleQueue}><ListMusic /></IconButton>
          <DevicesPopover
            player={player}
            trigger={<IconButton label="Devices" size="sm" className={cn(elsewhere && 'text-accent hover:text-accent')}><MonitorSpeaker /></IconButton>}
          />
          <VolumeControl volume={state.volume} onChange={controls.setVolume} className="hidden lg:flex [&>:last-child]:w-16" />
          <IconButton label="Now Playing" size="sm" disabled={!item} onClick={onOpenNowPlaying} className="hidden lg:inline-flex"><Maximize2 /></IconButton>
        </div>
      </div>
      {elsewhere && <PlayingElsewhere device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} />}
    </section>
  )
}

/** The phone layout's floating bubble, as in the iOS app. Tapping it opens Now Playing. */
export function MiniPlayer({ player, onOpenNowPlaying }: Pick<PlayerChromeProps, 'player' | 'onOpenNowPlaying'>) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = playingElsewhere(state)
  if (!item) return null
  return (
    <section aria-label="Player" className="relative mx-2 overflow-hidden rounded-xl bg-sheet ring-1 ring-stroke">
      <div className="flex h-14 items-center gap-1 pl-2 pr-1">
        <button type="button" aria-label={`Open Now Playing, ${item.track.title}`} onClick={onOpenNowPlaying} className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-xl text-left">
          <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-10 rounded-lg" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold">{item.track.title}</span>
            <span className={cn('block truncate text-xs font-medium', elsewhere ? 'text-accent' : 'text-muted')}>
              {elsewhere ? `Playing on ${elsewhere.name}` : item.track.artistCredit}
            </span>
          </span>
        </button>
        <DevicesPopover
          player={player}
          trigger={<IconButton label="Devices" tooltip={false} className="text-accent hover:text-accent"><MonitorSpeaker /></IconButton>}
        />
        <IconButton label={state.playing ? 'Pause' : 'Play'} tooltip={false} onClick={controls.togglePlay} className="text-foreground">
          {state.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </IconButton>
      </div>
      <MiniProgress durationMs={item.entry.durationMs} />
    </section>
  )
}

function MiniProgress({ durationMs }: { durationMs: number }) {
  const position = usePosition()
  return (
    <div aria-hidden className="absolute inset-x-4 bottom-0 h-0.5 overflow-hidden rounded-full bg-stroke">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (position / Math.max(durationMs, 1)) * 100)}%` }} />
    </div>
  )
}
