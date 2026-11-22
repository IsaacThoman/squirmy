import type { RepeatMode } from '@squirmy/contracts'
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Slider } from '@/components/ui/slider'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePosition, type Player } from '@/player/player-context'

/** Desktop-sized buttons grow to a 44px target where the pointer is a finger (a tablet). */
export const touchTarget = 'pointer-coarse:size-11'

type TransportButtonsProps = {
  player: Player
  large?: boolean
  disabled?: boolean
  /** Classes for shuffle and repeat, which a narrow bar can leave to the queue and Now Playing. */
  modeClassName?: string
}

/** Shuffle, previous, play or pause, next and repeat. */
export function TransportButtons({ player, large, disabled, modeClassName }: TransportButtonsProps) {
  const { state, controls } = player
  return (
    <div className={cn('flex items-center justify-center', large ? 'gap-2' : 'gap-1')}>
      <IconButton label={state.shuffle ? 'Turn off shuffle' : 'Shuffle'} size={large ? 'lg' : 'sm'} shape="round" pressed={state.shuffle} disabled={disabled} onClick={() => controls.setShuffle(!state.shuffle)} className={cn(large ? 'size-11' : touchTarget, modeClassName)}>
        <Shuffle />
      </IconButton>
      <IconButton label="Previous" size={large ? 'xl' : 'sm'} shape="round" disabled={disabled} onClick={controls.previous} className={cn('text-foreground', !large && touchTarget)}>
        <SkipBack fill="currentColor" />
      </IconButton>
      <PlayPauseButton playing={state.playing} loading={state.waiting} onClick={controls.togglePlay} large={large} disabled={disabled} className={large ? 'mx-2' : cn('mx-1', touchTarget)} />
      <IconButton label="Next" size={large ? 'xl' : 'sm'} shape="round" disabled={disabled} onClick={controls.next} className={cn('text-foreground', !large && touchTarget)}>
        <SkipForward fill="currentColor" />
      </IconButton>
      <RepeatButton repeat={state.repeat} onClick={controls.cycleRepeat} large={large} disabled={disabled} className={cn(!large && touchTarget, modeClassName)} />
    </div>
  )
}

type PlayPauseButtonProps = { playing: boolean; loading?: boolean; onClick: () => void; large?: boolean; disabled?: boolean; className?: string }

/**
 * The one round, filled button of the player. While the music is on its way it spins, as for
 * buffering; it still pauses.
 */
export function PlayPauseButton({ playing, loading = false, onClick, large, disabled, className }: PlayPauseButtonProps) {
  return (
    <IconButton
      label={playing ? 'Pause' : 'Play'}
      variant="contrast"
      shape="round"
      size={large ? 'xl' : 'md'}
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={cn(large && 'size-14', className)}
    >
      {loading ? <Spinner label="Loading" className="text-current" /> : playing ? <Pause fill="currentColor" /> : <Play className="translate-x-px" fill="currentColor" />}
    </IconButton>
  )
}

const repeatLabels: Record<RepeatMode, string> = { off: 'Repeat', all: 'Repeat one', one: 'Turn off repeat' }

function RepeatButton({ repeat, onClick, large, disabled, className }: { repeat: RepeatMode; onClick: () => void; large?: boolean; disabled?: boolean; className?: string }) {
  return (
    <IconButton label={repeatLabels[repeat]} size={large ? 'lg' : 'sm'} shape="round" pressed={repeat !== 'off'} disabled={disabled} onClick={onClick} className={cn(large && 'size-11', className)}>
      {repeat === 'one' ? <Repeat1 /> : <Repeat />}
    </IconButton>
  )
}

type SeekBarProps = {
  durationMs: number
  onSeek: (ms: number) => void
  disabled?: boolean
  /** The times go under the slider's ends instead of beside it. */
  stacked?: boolean
  className?: string
}

/** Elapsed time, the seek slider and the time left. Reads the clock itself so only it re-renders. */
export function SeekBar({ durationMs, onSeek, disabled, stacked, className }: SeekBarProps) {
  const position = usePosition()
  const [draft, setDraft] = useState<number | null>(null)
  const shown = Math.min(draft ?? position, durationMs)
  const elapsed = formatDuration(shown)
  // Nothing loaded shows as 0:00 at both ends, not as "−0:00" left.
  const left = durationMs ? `−${formatDuration(durationMs - shown)}` : formatDuration(0)
  const slider = (
    <Slider
      label="Seek"
      value={shown}
      max={Math.max(durationMs, 1)}
      step={1000}
      disabled={disabled}
      valueText={`${elapsed} of ${formatDuration(durationMs)}`}
      onValueChange={setDraft}
      onValueCommit={value => {
        onSeek(value)
        setDraft(null)
      }}
    />
  )
  if (stacked) {
    return (
      <div className={cn('w-full', className)}>
        {slider}
        <div className={cn('mt-1 flex justify-between text-xs tabular text-muted-foreground', disabled && 'opacity-50')}>
          <span>{elapsed}</span>
          <span>{left}</span>
        </div>
      </div>
    )
  }
  return (
    <div className={cn('flex w-full items-center gap-2 text-xs tabular text-muted-foreground', className)}>
      <span className={cn('min-w-9 shrink-0 text-right', disabled && 'opacity-50')}>{elapsed}</span>
      {slider}
      <span className={cn('min-w-9 shrink-0', disabled && 'opacity-50')}>{left}</span>
    </div>
  )
}

/**
 * The last volume heard on each device, which unmute goes back to. Kept apart from the
 * controls, so muting in the bar and unmuting in Now Playing or the devices list agree.
 */
const audibleVolumes = new Map<string, number>()

/** A mute toggle and a volume slider for `deviceId`'s volume. */
export function VolumeControl({ volume, onChange, deviceId, label = 'Volume', fill, className }: { volume: number; onChange: (volume: number) => void; deviceId: string; label?: string; fill?: boolean; className?: string }) {
  useEffect(() => {
    if (volume > 0) audibleVolumes.set(deviceId, volume)
  }, [deviceId, volume])
  const Icon = volume === 0 ? VolumeX : volume < 0.34 ? Volume : volume < 0.67 ? Volume1 : Volume2
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <IconButton
        label={volume === 0 ? 'Unmute' : 'Mute'}
        size="sm"
        onClick={() => {
          if (volume) audibleVolumes.set(deviceId, volume)
          onChange(volume ? 0 : audibleVolumes.get(deviceId) ?? 0.7)
        }}
      >
        <Icon />
      </IconButton>
      <Slider label={label} value={Math.round(volume * 100)} max={100} step={5} valueText={`${Math.round(volume * 100)}%`} onValueChange={value => onChange(value / 100)} className={fill ? 'flex-1' : 'w-20'} />
    </div>
  )
}
