import { CloudDownload, GripVertical, Infinity as InfinityIcon, Repeat, Repeat1, Shuffle, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Equalizer } from '@/components/music/Equalizer'
import { Cover } from '@/components/music/Cover'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { pillClass } from '@/components/ui/tabs'
import { dropIndex } from '@/lib/reorder'
import { cn } from '@/lib/utils'
import { useOnDemand } from '@/player/on-demand-context'
import type { Player, QueueItem } from '@/player/player-context'

const rowHeight = 56

/** The whole queue: what is playing, up next, history and autoplay. */
export function QueueContent({ player }: { player: Player }) {
  const { state, controls } = player
  return (
    <div className="flex flex-col gap-5 pb-5">
      {state.current && (
        <section aria-labelledby="queue-now">
          <QueueHeading id="queue-now">Now playing</QueueHeading>
          <QueueRow item={state.current} current playing={state.playing} />
        </section>
      )}

      <div className="flex flex-wrap gap-2 px-1">
        <button type="button" aria-pressed={state.shuffle} onClick={() => controls.setShuffle(!state.shuffle)} className={cn(pillClass, 'rounded-lg aria-pressed:bg-accent aria-pressed:text-on-accent')}>
          <Shuffle className="size-4" />Shuffle
        </button>
        <button type="button" aria-pressed={state.repeat !== 'off'} onClick={controls.cycleRepeat} className={cn(pillClass, 'rounded-lg aria-pressed:bg-accent aria-pressed:text-on-accent')}>
          {state.repeat === 'one' ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}{state.repeat === 'one' ? 'Repeat one' : 'Repeat'}
        </button>
      </div>

      <section aria-labelledby="queue-next">
        <QueueHeading
          id="queue-next"
          detail={state.queue.length ? `${state.queue.length} ${state.queue.length === 1 ? 'track' : 'tracks'}` : undefined}
          action={state.queue.length > 0 && <ClearButton label="Clear queue" onClick={controls.clearQueue} />}
        >
          Up next
        </QueueHeading>
        {state.queue.length
          ? <SortableQueue items={state.queue} onMove={controls.moveEntry} onRemove={controls.removeEntry} onPlay={controls.playEntry} />
          : <p className="px-2 text-sm text-muted">Songs you add to the queue appear here.</p>}
      </section>

      {state.history.length > 0 && (
        <section aria-labelledby="queue-history">
          <QueueHeading id="queue-history" action={<ClearButton label="Clear history" onClick={controls.clearHistory} />}>
            History
          </QueueHeading>
          <ul>{[...state.history].reverse().map(item => <li key={item.entry.id}><QueueRow item={item} onPlay={() => controls.playEntry(item.entry.id)} faded /></li>)}</ul>
        </section>
      )}

      <section aria-labelledby="queue-autoplay">
        <div className="flex min-h-8 items-center justify-between gap-3 px-2">
          <div className="flex items-center gap-2">
            <InfinityIcon aria-hidden className={cn('size-4', state.autoplay ? 'text-accent' : 'text-quiet')} />
            <h3 id="queue-autoplay" className="text-xs font-bold uppercase tracking-[0.08em] text-quiet">Autoplay</h3>
          </div>
          <Switch checked={state.autoplay} onCheckedChange={controls.setAutoplay} aria-label="Autoplay" />
        </div>
        <p className="mb-2 mt-1 px-2 text-[13px] text-muted">{state.autoplay ? 'Similar songs keep playing when your queue ends.' : 'Turn on Autoplay to keep listening.'}</p>
        {state.autoplay && <ul>{state.autoplayQueue.map(item => <li key={item.entry.id}><QueueRow item={item} onPlay={() => controls.playEntry(item.entry.id)} faded /></li>)}</ul>}
      </section>
    </div>
  )
}

function QueueHeading({ id, children, detail, action }: { id: string; children: ReactNode; detail?: string; action?: ReactNode }) {
  return (
    <div className="mb-1 flex min-h-8 items-center gap-2 px-2">
      <h3 id={id} className="mr-auto text-xs font-bold uppercase tracking-[0.08em] text-quiet">{children}</h3>
      {detail && <span className="text-xs font-semibold text-quiet">{detail}</span>}
      {action}
    </div>
  )
}

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" aria-label={label} onClick={onClick} className="-mr-1 rounded-md px-2 py-1 text-xs font-semibold text-accent hover:bg-selection">Clear</button>
}

type QueueRowProps = {
  item: QueueItem
  current?: boolean
  playing?: boolean
  faded?: boolean
  onPlay?: () => void
  children?: ReactNode
}

function QueueRow({ item, current, playing = false, faded, onPlay, children }: QueueRowProps) {
  const { track, entry } = item
  const onDemand = useOnDemand()
  // Upcoming on-demand entries all wait as `preparing`; only those the server is fetching say so.
  const preparing = entry.state === 'preparing' && onDemand.isPreparing(track)
  const waiting = entry.state === 'preparing' && !preparing
  const body = (
    <>
      <div className="relative size-10 shrink-0">
        <Cover artwork={track.album?.artwork ?? null} size={96} className="size-10 rounded-md ring-1 ring-stroke" />
        {(current || preparing) && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45">
            {preparing ? <Spinner label="Preparing" className="size-4 text-white" /> : <Equalizer playing={playing} className="text-white" />}
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span title={track.title} className={cn('truncate text-sm font-semibold', current && 'text-accent')}>{track.title}</span>
          {waiting && <Tooltip label="Plays on demand"><CloudDownload aria-label="Plays on demand" className="size-3.5 shrink-0 text-quiet" /></Tooltip>}
        </span>
        <span className="block truncate text-xs text-muted">{preparing ? 'Preparing…' : entry.state === 'failed' ? 'Could not be fetched' : track.artistCredit}</span>
      </span>
    </>
  )
  return (
    <div className={cn('group/queue flex h-14 items-center gap-1 rounded-[0.625rem] pr-1 transition-colors duration-100 hover:bg-overlay', current && 'bg-selection hover:bg-selection', faded && 'opacity-80 hover:opacity-100')}>
      {onPlay
        ? <button type="button" aria-label={`Play ${track.title}`} onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-[0.625rem] px-2">{body}</button>
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
                'relative rounded-[0.625rem]',
                dragging ? 'z-10 bg-dragged shadow-float' : 'transition-transform duration-150 ease-out',
              )}
            >
              <QueueRow item={item} onPlay={() => onPlay(item.entry.id)}>
                <IconButton label={`Remove ${item.track.title} from queue`} tooltip={false} size="sm" onClick={() => onRemove(item.entry.id)} className="opacity-0 focus-visible:opacity-100 group-hover/queue:opacity-100">
                  <X />
                </IconButton>
                <button
                  ref={element => {
                    if (element) handles.current.set(item.entry.id, element)
                    else handles.current.delete(item.entry.id)
                  }}
                  type="button"
                  aria-label={`Reorder ${item.track.title}, position ${index + 1} of ${items.length}`}
                  aria-describedby="queue-reorder-help"
                  onKeyDown={event => onKeyDown(event, index)}
                  onPointerDown={event => onPointerDown(event, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                  className={cn('flex size-8 touch-none items-center justify-center rounded-md text-quiet transition hover:text-foreground', dragging ? 'cursor-grabbing' : 'cursor-grab')}
                >
                  <GripVertical className="size-4" />
                </button>
              </QueueRow>
            </li>
          )
        })}
      </ul>
      <p id="queue-reorder-help" className="sr-only">Use the up and down arrow keys to move this song.</p>
      <p aria-live="polite" className="sr-only">{announcement}</p>
    </>
  )
}

/** The queue as a column beside the main view on wide screens and a sheet over it on narrower ones. */
export function QueuePanel({ player, onClose }: { player: Player; onClose: () => void }) {
  return (
    <aside aria-label="Queue" className="flex h-full w-full flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-stroke pl-4 pr-2.5">
        <h2 className="text-[15px] font-bold tracking-tight">Queue</h2>
        <IconButton label="Close queue" size="sm" onClick={onClose} className="rounded-lg"><X /></IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2 pt-3">
        <QueueContent player={player} />
      </ScrollArea>
    </aside>
  )
}
