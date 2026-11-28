import { Minimize2 } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Cover } from '@/components/music/Cover'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { hostControls, type Player } from '@/player/player-context'
import { LyricsPane } from './Lyrics'
import { PlayerStatusLine } from './PlayerStatus'
import { SongContextMenu } from './SongMenu'
import { SeekBar, TransportButtons } from './Transport'
import { LEAN_BACK_IDLE_MS, useIdle } from './use-idle'

type LeanBackProps = { player: Player; onExit: () => void; onNavigate: () => void }

/**
 * Now Playing for watching from across the room, as on a TV: the cover large, the lyrics beside it
 * when the song has some, over the ambient backdrop. The controls fade away a few seconds after the
 * last touch while music plays and come back with any key, pointer move or tap; a key that only
 * wakes them does nothing else, so Enter on a hidden button never acts unseen. In the transport
 * row ← and → move from button to button, as a TV remote expects. Escape leaves. A right-click on
 * the cover opens the song's menu, as in Now Playing.
 */
export function LeanBack({ player, onExit, onNavigate }: LeanBackProps) {
  const { state, controls } = player
  const item = state.current
  const artwork = item?.track.album?.artwork ?? null
  const hasLyrics = state.lyricsStatus !== 'none' && Boolean(item?.track.hasLyrics)
  const [idle, wake] = useIdle(LEAN_BACK_IDLE_MS, !state.playing)
  const root = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)

  // Focus starts on the screen itself rather than a button, whose tooltip would stay up over the
  // screen once the controls hide: there ← and → seek, ↑ and ↓ change the volume (the player's
  // own keys), and Enter, like Space, plays and pauses. Tab goes on to the controls.
  useEffect(() => root.current?.focus({ preventScroll: true }), [])

  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const asleep = idle
    wake()
    if (asleep && event.key === 'Enter' && event.target !== root.current) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.target !== root.current || !item || hostControls(player.state)) return
    event.preventDefault()
    controls.togglePlay()
  }
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const buttons = [...(row.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    event.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus()
  }

  return (
    <div
      ref={root}
      tabIndex={-1}
      aria-label="Full screen player"
      data-lean-back=""
      data-idle={idle || undefined}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
      className={cn('relative flex min-h-0 flex-1 flex-col outline-none', idle && 'cursor-none')}
    >
      <div className={cn('grid min-h-0 flex-1 items-center gap-[6vw] px-[7vw] pb-[clamp(8rem,18vh,12rem)] pt-[6vh]', hasLyrics ? 'grid-cols-[minmax(0,5fr)_minmax(0,6fr)]' : 'justify-items-center')}>
        <div className="flex min-w-0 flex-col gap-[3vh]">
          {item
            ? <SongContextMenu track={item.track} onNavigate={onNavigate}><div><Cover artwork={artwork} size={1200} crossfade className="size-[min(62vh,40vw)] rounded-2xl shadow-[0_32px_80px_-24px_rgb(0_0_0/0.6)]" /></div></SongContextMenu>
            : <Cover artwork={artwork} size={1200} crossfade className="size-[min(62vh,40vw)] rounded-2xl shadow-[0_32px_80px_-24px_rgb(0_0_0/0.6)]" />}
          <div className="min-w-0 max-w-[min(62vh,40vw)]">
            <h2 className="truncate text-[clamp(1.75rem,3.4vh,3rem)] font-semibold tracking-tight">{item?.track.title ?? 'Nothing playing'}</h2>
            {item && <p className="truncate text-[clamp(1.125rem,2.4vh,2rem)] text-muted-foreground">{item.track.artistCredit}</p>}
            <PlayerStatusLine status={state.status} className="mt-1 text-base" />
          </div>
        </div>
        {hasLyrics && (
          <div className="h-[min(78vh,100%)] min-h-0 min-w-0 [&_[role=option]]:text-[clamp(2rem,4.6vh,4rem)] [&_[role=option]]:leading-tight">
            <LyricsPane lyrics={state.lyrics} onSeek={controls.seek} />
          </div>
        )}
      </div>

      <div
        data-lean-back-controls=""
        className={cn(
          'absolute inset-x-0 bottom-0 px-[7vw] pb-[max(4vh,env(safe-area-inset-bottom))] pt-16 transition-[opacity,translate] duration-500 ease-out',
          'bg-linear-to-t from-background via-background/80 to-transparent',
          idle && 'pointer-events-none translate-y-3 opacity-0',
        )}
      >
        <SeekBar stacked durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item || hostControls(player.state)} className="mx-auto max-w-5xl" />
        <div ref={row} data-own-keys="" onKeyDown={onRowKeyDown} className="relative mx-auto mt-2 flex max-w-5xl items-center justify-center">
          <TransportButtons player={player} large disabled={!item || hostControls(player.state)} />
          <div className="absolute inset-y-0 right-0 flex items-center">
            <IconButton label="Exit full screen" size="lg" onClick={onExit} className="size-11 text-foreground"><Minimize2 /></IconButton>
          </div>
        </div>
      </div>
    </div>
  )
}
