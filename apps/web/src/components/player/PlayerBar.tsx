import { Heart, ListMusic, Maximize2, MonitorSpeaker, Pause, Play, Quote } from 'lucide-react'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { usePosition, type Player } from '@/player/player-context'
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

function activeElsewhere({ state }: Player) {
  return state.activeDeviceId !== state.thisDeviceId ? state.devices.find(device => device.id === state.activeDeviceId) : undefined
}

/** The desktop player along the bottom of the window, over a blur of whatever scrolls behind it. */
export function PlayerBar({ player, liked, onToggleLike, queueOpen, onToggleQueue, lyricsOpen, onToggleLyrics, onOpenNowPlaying }: PlayerChromeProps) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = activeElsewhere(player)
  return (
    <div className="border-t border-stroke bg-floating backdrop-blur-2xl backdrop-saturate-150">
      <div className="grid h-[5.5rem] grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-4 px-4">
        <div className="flex min-w-0 items-center gap-3">
          {item && (
            <>
              <button type="button" aria-label="Open Now Playing" onClick={onOpenNowPlaying} className="group relative shrink-0 rounded-lg">
                <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-14 rounded-lg shadow-cover" />
                <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 className="size-4" />
                </span>
              </button>
              <div className="min-w-0">
                {item.track.album
                  ? <Link to={`/album/${item.track.album.id}`} className="block truncate text-sm font-semibold hover:underline">{item.track.title}</Link>
                  : <p className="truncate text-sm font-semibold">{item.track.title}</p>}
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
          )}
        </div>

        <div className="flex min-w-0 flex-col items-center gap-1">
          <TransportButtons player={player} disabled={!item} />
          <SeekBar durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} className="max-w-[40rem]" />
        </div>

        <div className="flex items-center justify-end gap-0.5">
          <IconButton label={lyricsOpen ? 'Hide lyrics' : 'Lyrics'} size="sm" pressed={lyricsOpen} disabled={!item} onClick={onToggleLyrics}><Quote /></IconButton>
          <IconButton label={queueOpen ? 'Hide queue' : 'Queue'} size="sm" pressed={queueOpen} onClick={onToggleQueue}><ListMusic /></IconButton>
          <DevicesPopover
            devices={state.devices}
            activeDeviceId={state.activeDeviceId}
            thisDeviceId={state.thisDeviceId}
            onTransfer={controls.transfer}
            trigger={<IconButton label="Devices" size="sm" className={cn(elsewhere && 'text-accent hover:text-accent')}><MonitorSpeaker /></IconButton>}
          />
          <VolumeControl volume={state.volume} onChange={controls.setVolume} className="hidden lg:flex" />
          <IconButton label="Now Playing" size="sm" disabled={!item} onClick={onOpenNowPlaying} className="hidden lg:inline-flex"><Maximize2 /></IconButton>
        </div>
      </div>
      {elsewhere && <PlayingElsewhere device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} />}
    </div>
  )
}

/** The phone layout's floating bubble, as in the iOS app. Tapping it opens Now Playing. */
export function MiniPlayer({ player, onOpenNowPlaying }: Pick<PlayerChromeProps, 'player' | 'onOpenNowPlaying'>) {
  const { state, controls } = player
  const item = state.current
  const elsewhere = activeElsewhere(player)
  if (!item) return null
  return (
    <div className="relative mx-2 overflow-hidden rounded-2xl bg-floating shadow-float backdrop-blur-2xl backdrop-saturate-150">
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
          devices={state.devices}
          activeDeviceId={state.activeDeviceId}
          thisDeviceId={state.thisDeviceId}
          onTransfer={controls.transfer}
          trigger={<IconButton label="Devices" tooltip={false} className="text-accent hover:text-accent"><MonitorSpeaker /></IconButton>}
        />
        <IconButton label={state.playing ? 'Pause' : 'Play'} tooltip={false} onClick={controls.togglePlay} className="text-foreground">
          {state.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </IconButton>
      </div>
      <MiniProgress durationMs={item.entry.durationMs} />
    </div>
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
