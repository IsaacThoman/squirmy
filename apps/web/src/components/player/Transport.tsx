import type { RepeatMode } from '@squirmy/contracts'
import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { Slider } from '@/components/ui/slider'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { usePosition, type Player } from '@/player/player-context'

/** Shuffle, previous, play or pause, next and repeat. */
export function TransportButtons({ player, large, disabled }: { player: Player; large?: boolean; disabled?: boolean }) {
  const { state, controls } = player
  return (
    <div className={cn('flex items-center justify-center', large ? 'gap-5' : 'gap-2')}>
      <IconButton label={state.shuffle ? 'Turn off shuffle' : 'Shuffle'} size={large ? 'lg' : 'sm'} pressed={state.shuffle} disabled={disabled} onClick={() => controls.setShuffle(!state.shuffle)}>
        <Shuffle />
      </IconButton>
      <IconButton label="Previous" size={large ? 'lg' : 'md'} disabled={disabled} onClick={controls.previous} className="text-foreground">
        <SkipBack fill="currentColor" />
      </IconButton>
      <PlayPauseButton playing={state.playing} onClick={controls.togglePlay} large={large} disabled={disabled} />
      <IconButton label="Next" size={large ? 'lg' : 'md'} disabled={disabled} onClick={controls.next} className="text-foreground">
        <SkipForward fill="currentColor" />
      </IconButton>
      <RepeatButton repeat={state.repeat} onClick={controls.cycleRepeat} large={large} disabled={disabled} />
    </div>
  )
}

export function PlayPauseButton({ playing, onClick, large, disabled, className }: { playing: boolean; onClick: () => void; large?: boolean; disabled?: boolean; className?: string }) {
  return (
    <IconButton label={playing ? 'Pause' : 'Play'} variant="contrast" size={large ? 'xl' : 'md'} disabled={disabled} onClick={onClick} className={className}>
      {playing ? <Pause fill="currentColor" /> : <Play className="translate-x-px" fill="currentColor" />}
    </IconButton>
  )
}

const repeatLabels: Record<RepeatMode, string> = { off: 'Repeat', all: 'Repeat one', one: 'Turn off repeat' }

function RepeatButton({ repeat, onClick, large, disabled }: { repeat: RepeatMode; onClick: () => void; large?: boolean; disabled?: boolean }) {
  return (
    <IconButton label={repeatLabels[repeat]} size={large ? 'lg' : 'sm'} pressed={repeat !== 'off'} disabled={disabled} onClick={onClick}>
      {repeat === 'one' ? <Repeat1 /> : <Repeat />}
    </IconButton>
  )
}

/** Elapsed time, the seek slider and the time left. Reads the clock itself so only it re-renders. */
export function SeekBar({ durationMs, onSeek, disabled, className }: { durationMs: number; onSeek: (ms: number) => void; disabled?: boolean; className?: string }) {
  const position = usePosition()
  const [draft, setDraft] = useState<number | null>(null)
  const shown = Math.min(draft ?? position, durationMs)
  return (
    <div className={cn('flex w-full items-center gap-2.5 text-[11px] font-semibold tabular text-quiet', className)}>
      <span className="w-10 text-right">{formatDuration(shown)}</span>
      <Slider
        label="Seek"
        value={shown}
        max={Math.max(durationMs, 1)}
        step={1000}
        disabled={disabled}
        valueText={`${formatDuration(shown)} of ${formatDuration(durationMs)}`}
        onValueChange={setDraft}
        onValueCommit={value => {
          onSeek(value)
          setDraft(null)
        }}
      />
      <span className="w-10">−{formatDuration(durationMs - shown)}</span>
    </div>
  )
}

/** A mute toggle and a volume slider. */
export function VolumeControl({ volume, onChange, className }: { volume: number; onChange: (volume: number) => void; className?: string }) {
  const [restore, setRestore] = useState(volume || 0.7)
  const Icon = volume === 0 ? VolumeX : volume < 0.34 ? Volume : volume < 0.67 ? Volume1 : Volume2
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <IconButton
        label={volume === 0 ? 'Unmute' : 'Mute'}
        size="sm"
        onClick={() => {
          if (volume) setRestore(volume)
          onChange(volume ? 0 : restore)
        }}
      >
        <Icon />
      </IconButton>
      <Slider label="Volume" value={Math.round(volume * 100)} max={100} step={5} valueText={`${Math.round(volume * 100)}%`} onValueChange={value => onChange(value / 100)} className="w-24" />
    </div>
  )
}
