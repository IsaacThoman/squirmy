import { sleepTimerAccessibilityLabel, sleepTimerChoiceId, sleepTimerChoices, sleepTimerLabel, type SleepView } from '@squirmy/client-core'
import { Moon, TimerOff } from 'lucide-react'
import { use, useEffect, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { cn } from '@/lib/utils'
import { PositionContext, type Player, type PlayerState } from '@/player/player-context'

/**
 * What the player shows of a sleep timer, read again every second while one is set: the time
 * left (or what it waits for), and how a screen reader says it. Null while none is set.
 */
function useSleepTimerLine(state: PlayerState): { label: string; spoken: string } | null {
  const clock = use(PositionContext)
  const timer = state.sleepTimer
  const { serverNow } = state
  const [now, setNow] = useState(() => serverNow?.() ?? Date.now())
  useEffect(() => {
    if (!timer) return
    const read = () => setNow(serverNow?.() ?? Date.now())
    read()
    const interval = setInterval(read, 1000)
    return () => clearInterval(interval)
  }, [timer, serverNow])
  if (!timer) return null
  const view: SleepView = {
    sleepTimer: timer,
    current: state.current?.entry ?? null,
    queue: state.queue.map(item => item.entry),
    repeat: state.repeat,
    context: state.context,
    // The position is the clock's own; the rest of the arithmetic is not needed.
    playing: false, stalled: false, positionMs: 0, anchorAt: 0,
  }
  const label = sleepTimerLabel(view, now, clock.get())
  const spoken = sleepTimerAccessibilityLabel(view, now, clock.get())
  return label && spoken ? { label, spoken } : null
}

function sleepTimerEntries({ state, controls }: Player): MenuEntry[] {
  const chosen = sleepTimerChoiceId(state.sleepTimer)
  return [
    { kind: 'label', label: 'Sleep timer' },
    ...sleepTimerChoices(state.context).map((choice): MenuEntry => ({
      label: choice.label,
      checked: choice.id === chosen,
      onSelect: () => controls.setSleepTimer(choice.request),
    })),
    ...(state.sleepTimer
      ? [{ kind: 'separator' as const }, { label: 'Turn off timer', icon: <TimerOff />, onSelect: () => controls.setSleepTimer(null) }]
      : []),
  ]
}

type SleepTimerProps = { player: Player; className?: string; side?: 'top' | 'bottom' }

/**
 * Now Playing's sleep timer: a moon that opens the lengths and ends to choose from, drawn in the
 * action color while a timer is set. The timer is the session's, so it stops whichever device
 * plays. Nothing shows when the server does not take one.
 */
export function SleepTimerButton({ player, className, side = 'top' }: SleepTimerProps) {
  const line = useSleepTimerLine(player.state)
  if (!player.state.canSetSleepTimer) return null
  return (
    <DropdownMenu
      side={side}
      align="start"
      entries={sleepTimerEntries(player)}
      trigger={<IconButton label={line?.spoken ?? 'Sleep timer'} pressed={Boolean(line)} className={className}><Moon /></IconButton>}
    />
  )
}

/**
 * The player bar's sign of a sleep timer while one is set: a moon and the time left, which
 * opens the same menu. Setting one is Now Playing's; the bar only says one is on.
 */
export function SleepTimerChip({ player, className }: Omit<SleepTimerProps, 'side'>) {
  const line = useSleepTimerLine(player.state)
  if (!player.state.canSetSleepTimer || !line) return null
  return (
    <DropdownMenu
      side="top"
      entries={sleepTimerEntries(player)}
      trigger={(
        <button
          type="button"
          aria-label={line.spoken}
          title={line.spoken}
          className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium tabular-nums text-primary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11', className)}
        >
          <Moon aria-hidden className="size-3.5" />{line.label}
        </button>
      )}
    />
  )
}
