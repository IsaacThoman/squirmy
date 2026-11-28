import { Check, CircleAlert, ListPlus, MoreHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu, MENU_DONE_MS, type MenuEntry, type MenuItem } from '@/components/ui/menu'
import { cn } from '@/lib/utils'

/** One of the bar's buttons, described as a menu item is so the two say the same. */
export type BarAction = MenuItem & { key: string }

type Feedback = { key: string; state: 'pending' | 'done' } | { key: string; state: 'failed'; message: string }

type SelectionBarProps = {
  /** "3 songs selected". */
  summary: string
  /** Drawn with its words (Play). */
  primary?: BarAction
  /** Icons named by their tooltips. */
  actions: BarAction[]
  /** Add to playlist's choices, as the song menu lists them. */
  playlists?: MenuEntry[]
  /** Everything the selection offers, behind More. */
  menu: MenuEntry[]
  onClear: () => void
  className?: string
}

/**
 * What can be done with the songs picked in a list: a bar that stays in view at the bottom of the
 * list while any are picked. It is the selection's controls, not news: what a button did shows on
 * the button for a moment (as a menu item's `done` does), and a refusal is said in the bar.
 */
export function SelectionBar({ summary, primary, actions, playlists, menu, onClear, className }: SelectionBarProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const settle = (next: Feedback | null, ms: number) => {
    clearTimeout(timer.current)
    setFeedback(next)
    if (next) timer.current = setTimeout(() => setFeedback(null), ms)
  }
  const run = (action: BarAction) => {
    const result = action.onSelect()
    if (!(result instanceof Promise)) return action.done ? settle({ key: action.key, state: 'done' }, MENU_DONE_MS) : settle(null, 0)
    setFeedback({ key: action.key, state: 'pending' })
    result.then(
      () => settle(action.done ? { key: action.key, state: 'done' } : null, MENU_DONE_MS),
      (error: unknown) => settle({ key: action.key, state: 'failed', message: errorMessage(error) }, 5000),
    )
  }
  const shownFor = (key: string) => (feedback?.key === key ? feedback : null)
  const said = feedback?.state === 'done' ? [primary, ...actions].find(action => action?.key === feedback.key)?.done : null

  const icon = (action: BarAction): ReactNode => {
    const shown = shownFor(action.key)
    return shown?.state === 'pending' ? <Spinner label={null} className="size-4" />
      : shown?.state === 'done' ? <Check className="text-primary" />
        : shown?.state === 'failed' ? <CircleAlert className="text-destructive" />
          : action.icon
  }

  return (
    // No height of its own, so the page does not move as it appears. It hangs below the end of the
    // list, under its last song, and while the end is out of view it stays at the bottom of the view.
    <div data-selection-bar="" className={cn('pointer-events-none sticky bottom-16 z-20 h-0', className)}>
      <div
        role="toolbar"
        aria-label="Selected songs"
        className="pointer-events-auto absolute inset-x-2 top-2 mx-auto flex w-fit max-w-[calc(100%-1rem)] animate-enter items-center gap-1 overflow-x-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        <span className="shrink-0 whitespace-nowrap px-2 text-sm font-medium tabular">{summary}</span>
        {primary && (
          <Button size="sm" variant="primary" disabled={primary.disabled} onClick={() => run(primary)}>
            {icon(primary)}{primary.label}
          </Button>
        )}
        {actions.map(action => (
          <IconButton
            key={action.key}
            label={shownFor(action.key)?.state === 'done' && action.done ? action.done : action.label}
            size="sm"
            disabled={action.disabled}
            aria-busy={shownFor(action.key)?.state === 'pending' || undefined}
            onClick={() => run(action)}
            className={cn(action.danger && 'text-destructive hover:text-destructive')}
          >
            {icon(action)}
          </IconButton>
        ))}
        {playlists && (
          <DropdownMenu
            side="top"
            entries={playlists}
            trigger={<IconButton label="Add to playlist" size="sm"><ListPlus /></IconButton>}
          />
        )}
        <DropdownMenu
          side="top"
          entries={menu}
          trigger={<IconButton label="More options for the selected songs" size="sm"><MoreHorizontal /></IconButton>}
        />
        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
        <IconButton label="Clear selection" size="sm" onClick={onClear}><X /></IconButton>
        {/* A refusal, said beside the buttons and read out. */}
        {feedback?.state === 'failed' && <span role="status" className="shrink-0 whitespace-nowrap px-2 text-xs text-destructive">{feedback.message}</span>}
        {/* What a button did, read out: its icon changing says nothing to a screen reader. */}
        <span role="status" className="sr-only">{said}</span>
      </div>
    </div>
  )
}
