import { GripVertical, Infinity as InfinityIcon, Repeat, Repeat1, Shuffle, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Equalizer } from '@/components/music/Equalizer'
import { Cover } from '@/components/music/Cover'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { dropIndex } from '@/lib/reorder'
import { UNAVAILABLE_LABEL } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import type { Player, QueueItem } from '@/player/player-context'

const rowHeight = 48

const labelClass = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const toggleClass = 'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-primary [&_svg]:size-3.5'

/**
 * The whole queue: what is playing, up next, autoplay and history. `modes` shows shuffle and repeat
 * under what is playing, for where the transport is not right there.
 */
export function QueueContent({ player, modes = true }: { player: Player; modes?: boolean }) {
  const { state, controls } = player
  // The queue can be on screen twice, as the panel and as a pane of Now Playing.
  const id = useId()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {state.current && (
          <section aria-labelledby={`${id}-now`}>
            <QueueHeading id={`${id}-now`}>Now playing</QueueHeading>
            <QueueRow item={state.current} current playing={state.playing} />
          </section>
        )}
        {modes && (
          <div className="flex flex-wrap gap-1.5 px-2">
            <button type="button" aria-pressed={state.shuffle} onClick={() => controls.setShuffle(!state.shuffle)} className={toggleClass}>
              <Shuffle aria-hidden />Shuffle
            </button>
            <button type="button" aria-pressed={state.repeat !== 'off'} onClick={controls.cycleRepeat} className={toggleClass}>
              {state.repeat === 'one' ? <Repeat1 aria-hidden /> : <Repeat aria-hidden />}{state.repeat === 'one' ? 'Repeat one' : 'Repeat'}
            </button>
          </div>
        )}
      </div>

      <section aria-labelledby={`${id}-next`}>
        <QueueHeading
          id={`${id}-next`}
          detail={state.queue.length ? `${state.queue.length} ${state.queue.length === 1 ? 'track' : 'tracks'}` : undefined}
          action={state.queue.length > 0 && <ClearButton label="Clear queue" onClick={controls.clearQueue} />}
        >
          Up next
        </QueueHeading>
        {state.queue.length
          ? <SortableQueue items={state.queue} onMove={controls.moveEntry} onRemove={controls.removeEntry} onPlay={controls.playEntry} />
          : <p className="px-2 py-1 text-sm text-muted-foreground">Songs you add to the queue appear here.</p>}
      </section>

      <section aria-labelledby={`${id}-autoplay`}>
        <div className="flex h-7 items-center gap-1.5 px-2">
          <InfinityIcon aria-hidden className={cn('size-3.5', state.autoplay ? 'text-primary' : 'text-muted-foreground')} />
          <h3 id={`${id}-autoplay`} className={labelClass}>Autoplay</h3>
          <Switch checked={state.autoplay} onCheckedChange={controls.setAutoplay} aria-label="Autoplay" className="ml-auto" />
        </div>
        <p className="px-2 pb-1 text-xs text-muted-foreground">{state.autoplay ? 'Similar songs keep playing when your queue ends.' : 'Turn on Autoplay to keep listening.'}</p>
        {state.autoplay && <ul>{state.autoplayQueue.map(item => <li key={item.entry.id}><QueueRow item={item} onPlay={() => controls.playEntry(item.entry.id)} faded /></li>)}</ul>}
      </section>

      {state.history.length > 0 && (
        <section aria-labelledby={`${id}-history`}>
          <QueueHeading id={`${id}-history`} action={<ClearButton label="Clear history" onClick={controls.clearHistory} />}>
            History
          </QueueHeading>
          <ul>{[...state.history].reverse().map(item => <li key={item.entry.id}><QueueRow item={item} onPlay={() => controls.playEntry(item.entry.id)} faded /></li>)}</ul>
        </section>
      )}
    </div>
  )
}

function QueueHeading({ id, children, detail, action }: { id: string; children: ReactNode; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-2 px-2">
      <h3 id={id} className={labelClass}>{children}</h3>
      {detail && <span className="text-xs tabular text-muted-foreground">{detail}</span>}
      {action && <span className="ml-auto flex">{action}</span>}
    </div>
  )
}

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="-mr-1.5 h-6 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      Clear
    </button>
  )
}

type QueueRowProps = {
  item: QueueItem
  current?: boolean
  playing?: boolean
  faded?: boolean
  onPlay?: () => void
  children?: ReactNode
}

/**
 * A song in the queue. Songs still being fetched look like any other: only the current one,
 * while its music is on its way, shows the spinner. One that could not be had is gray, says
 * "Not available" and does not play.
 */
function QueueRow({ item, current, playing = false, faded, onPlay: play, children }: QueueRowProps) {
  const { track, entry } = item
  const failed = entry.state === 'failed'
  const loading = current && entry.state === 'preparing'
  const onPlay = failed ? undefined : play
  const body = (
    <>
      <div className="relative size-9 shrink-0">
        <Cover artwork={track.album?.artwork ?? null} size={96} dimmed={failed} className="size-9 rounded-[5px]" />
        {current && (
          <div className="absolute inset-0 flex items-center justify-center rounded-[5px] bg-black/50">
            {loading ? <Spinner label="Loading" className="size-4 text-white" /> : <Equalizer playing={playing} className="h-3 text-white" />}
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1 text-left">
        <span title={track.title} className={cn('block truncate text-sm font-medium', current && 'text-primary', failed && 'text-muted-foreground')}>{track.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{failed ? UNAVAILABLE_LABEL : track.artistCredit}</span>
      </span>
    </>
  )
  return (
    <div title={failed ? UNAVAILABLE_LABEL : undefined} className={cn('group/queue flex h-12 items-center rounded-lg pr-1 transition-[background-color,opacity]', onPlay && 'hover:bg-accent/60', faded && 'opacity-70 focus-within:opacity-100 hover:opacity-100')}>
      {onPlay
        ? <button type="button" aria-label={`Play ${track.title}`} onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{body}</button>
        : <div className="flex min-w-0 flex-1 items-center gap-3 px-2">{body}</div>}
      {children}
    </div>
  )
}

type SortableQueueProps = {
  items: QueueItem[]
  onMove: (entryId: string, toIndex: number) => void
  onRemove: (entryId: string) => void
  onPlay: (entryId: string) => void
}

/**
 * Up next, reorderable by dragging a row's handle or, with the handle focused, the arrow keys.
 * Rows are a fixed height, so the drop position is the drag distance in rows.
 */
export function SortableQueue({ items, onMove, onRemove, onPlay }: SortableQueueProps) {
  const [drag, setDrag] = useState<{ index: number; startY: number; offset: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const helpId = useId()
  const refocus = useRef<string | null>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const target = drag ? dropIndex(drag.index, drag.offset, rowHeight, items.length) : -1

  // A moved row's DOM node can lose focus as it is reinserted; give it back.
  useEffect(() => {
    if (!refocus.current) return
    handles.current.get(refocus.current)?.focus()
    refocus.current = null
  }, [items])

  const move = (item: QueueItem, to: number) => {
    onMove(item.entry.id, to)
    setAnnouncement(`${item.track.title} moved to position ${to + 1} of ${items.length}`)
  }

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
    if (to === null) return
    event.preventDefault()
    if (to < 0 || to >= items.length) return
    refocus.current = items[index].entry.id
    move(items[index], to)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ index, startY: event.clientY, offset: 0 })
  }
  const onPointerMove = (event: PointerEvent) => {
    if (drag) setDrag({ ...drag, offset: event.clientY - drag.startY })
  }
  const onPointerUp = () => {
    if (!drag) return
    if (target !== drag.index) move(items[drag.index], target)
    setDrag(null)
  }

  return (
    <>
      <ul className="relative">
        {items.map((item, index) => {
          const dragging = drag?.index === index
          let shift = 0
          if (drag && !dragging) {
            if (index > drag.index && index <= target) shift = -rowHeight
            if (index < drag.index && index >= target) shift = rowHeight
          }
          return (
            <li
              key={item.entry.id}
              style={{ transform: `translateY(${dragging ? drag.offset : shift}px)` }}
              className={cn(
                'relative rounded-lg',
                dragging ? 'z-10 bg-accent shadow-md' : 'transition-transform duration-150 ease-out',
              )}
            >
              <QueueRow item={item} onPlay={() => onPlay(item.entry.id)}>
                {/* Without a pointer that hovers, the button is always there to tap. */}
                <IconButton label={`Remove ${item.track.title} from queue`} tooltip={false} size="sm" onClick={() => onRemove(item.entry.id)} className="opacity-0 focus-visible:opacity-100 group-hover/queue:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100">
                  <X />
                </IconButton>
                <button
                  ref={element => {
                    if (element) handles.current.set(item.entry.id, element)
                    else handles.current.delete(item.entry.id)
                  }}
                  type="button"
                  aria-label={`Reorder ${item.track.title}, position ${index + 1} of ${items.length}`}
                  aria-describedby={helpId}
                  onKeyDown={event => onKeyDown(event, index)}
                  onPointerDown={event => onPointerDown(event, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                  className={cn('flex h-8 w-6 touch-none items-center justify-center rounded-md pointer-coarse:h-11 pointer-coarse:w-9 text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring', dragging ? 'cursor-grabbing text-foreground' : 'cursor-grab')}
                >
                  <GripVertical aria-hidden className="size-4" />
                </button>
              </QueueRow>
            </li>
          )
        })}
      </ul>
      <p id={helpId} className="sr-only">Use the up and down arrow keys to move this song.</p>
      <p aria-live="polite" className="sr-only">{announcement}</p>
    </>
  )
}

/** The queue under its title bar. The shell docks it beside the page or floats it over the page. */
export function QueuePanel({ player, onClose }: { player: Player; onClose: () => void }) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b pl-4 pr-2">
        <h2 className="text-sm font-semibold">Queue</h2>
        <IconButton label="Close queue" size="sm" onClick={onClose}><X /></IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-4 pt-3"><QueueContent player={player} /></div>
      </ScrollArea>
    </div>
  )
}
