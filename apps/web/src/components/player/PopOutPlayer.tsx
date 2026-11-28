import { Heart, SkipBack, SkipForward } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Cover } from '@/components/music/Cover'
import { IconButton } from '@/components/ui/icon-button'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { hostControls, usePlayer, usePosition } from '@/player/player-context'
import { PlayerStatusLine } from './PlayerStatus'
import { progressPosition } from './progress'
import { setWindowTitle } from './pop-out'
import { PlayPauseButton } from './Transport'

/** The player in its own window: the artwork, the song, the transport and the heart. */
export function PopOutPlayer({ target }: { target: Window }) {
  return createPortal(<PopOutContent target={target} />, target.document.body)
}

function PopOutContent({ target }: { target: Window }) {
  const { state, controls } = usePlayer()
  const library = useLibrary()
  const item = state.current
  const track = item?.track
  // The host plays, pauses and skips in a jam this user follows, as in the main window.
  const transport = Boolean(item) && !hostControls(state)

  // Space plays and pauses there too; the window has no other controls that want it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Not `keyIsTaken`: the window's elements are not this window's `Element`s.
      const focused = event.target as { closest?: (selector: string) => unknown } | null
      if (!transport || event.key !== ' ' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || focused?.closest?.('button, a[href], input')) return
      event.preventDefault()
      controls.togglePlay()
    }
    target.addEventListener('keydown', onKeyDown)
    return () => target.removeEventListener('keydown', onKeyDown)
  }, [target, controls, transport])

  useEffect(() => setWindowTitle(target, track ? `${track.title} · ${track.artistCredit}` : 'Squirmy'), [target, track])

  return (
    <div className="flex h-dvh select-none flex-col gap-3 bg-sidebar p-3 text-sidebar-foreground [--accent:var(--sidebar-accent)]">
      <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
        <Cover artwork={track?.album?.artwork ?? null} size={600} className="size-[min(100cqw,100cqh)] rounded-lg shadow-lg" />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <p title={track?.title} className={cn('truncate text-sm font-medium', !track && 'text-muted-foreground')}>{track?.title ?? 'Nothing playing'}</p>
          {track && <p title={track.artistCredit} className="truncate text-xs text-muted-foreground">{track.artistCredit}</p>}
          <PlayerStatusLine status={state.status} />
        </div>
        {track && (
          <IconButton
            label={track.liked ? `Remove ${track.title} from library` : `Save ${track.title} to library`}
            tooltip={false}
            size="sm"
            pressed={track.liked}
            onClick={() => void library.setSaved({ type: 'track', id: track.id, title: track.title }, !track.liked)}
          >
            <Heart fill={track.liked ? 'currentColor' : 'none'} />
          </IconButton>
        )}
      </div>
      <Progress durationMs={item?.entry.durationMs ?? 0} />
      <div className="flex items-center justify-center gap-2">
        <IconButton label="Previous" tooltip={false} shape="round" disabled={!transport} onClick={controls.previous} className="text-foreground"><SkipBack fill="currentColor" /></IconButton>
        <PlayPauseButton playing={state.playing} loading={state.waiting} disabled={!transport} onClick={controls.togglePlay} />
        <IconButton label="Next" tooltip={false} shape="round" disabled={!transport} onClick={controls.next} className="text-foreground"><SkipForward fill="currentColor" /></IconButton>
      </div>
    </div>
  )
}

/** How far the song is, with the time on either side: to read, not to drag (the main window seeks). */
function Progress({ durationMs }: { durationMs: number }) {
  const position = usePosition(positionMs => Math.floor(progressPosition(positionMs, durationMs) / 1000) * 1000)
  const share = Math.min(1, Math.max(0, position / Math.max(durationMs, 1)))
  return (
    <div className="flex items-center gap-2 text-[11px] tabular text-muted-foreground">
      <span className="min-w-8 text-right">{formatDuration(position)}</span>
      <div aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-input">
        <div className="h-full origin-left rounded-full bg-foreground" style={{ transform: `scaleX(${share})` }} />
      </div>
      <span className="min-w-8">{durationMs ? formatDuration(durationMs) : '–'}</span>
    </div>
  )
}
