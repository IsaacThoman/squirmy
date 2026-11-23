import { readsUnavailable, type SessionOutage } from '@squirmy/client-core'
import { Infinity as InfinityIcon, Repeat, Repeat1, Shuffle, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Equalizer } from '@/components/music/Equalizer'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { dropIndex } from '@/lib/reorder'
import { UNAVAILABLE_LABEL } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import type { Player, QueueItem } from '@/player/player-context'
import { touchTarget } from './Transport'

const rowHeight = 48

const labelClass = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground'
const toggleClass = 'inline-flex h-7 pointer-coarse:h-11 items-center gap-1.5 rounded-md border px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary/30 aria-pressed:bg-primary/10 aria-pressed:text-foreground aria-pressed:[&_svg]:text-primary [&_svg]:size-3.5'

/**
 * The whole queue: what is playing, up next, autoplay and history. `modes` shows shuffle and repeat
 * under what is playing, for where the transport is not right there.
 */
export function QueueContent({ player, modes = true }: { player: Player; modes?: boolean }) {
  const { state, controls } = player
  // The queue can be on screen twice, as the panel and as a pane of Now Playing.
  const id = useId()
  const [clearingHistory, setClearingHistory] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {state.current && (
          <section aria-labelledby={`${id}-now`}>
            <QueueHeading id={`${id}-now`}>Now playing</QueueHeading>
            <QueueRow item={state.current} current playing={state.playing} waiting={state.waiting} outage={state.outage} />
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
          <QueueHeading id={`${id}-history`} action={<ClearButton label="Clear history" onClick={() => setClearingHistory(true)} />}>
            History
          </QueueHeading>
          <ul>{[...state.history].reverse().map(item => <li key={item.entry.id}><QueueRow item={item} onPlay={() => controls.playEntry(item.entry.id)} faded /></li>)}</ul>
        </section>
      )}
      {/* Nothing brings a cleared history back, so it is asked first. */}
      <ConfirmDialog
        open={clearingHistory}
        onOpenChange={setClearingHistory}
        title="Clear history?"
        description="The songs you played leave the history on all your devices. This can’t be undone."
        confirmLabel="Clear history"
        onConfirm={async () => controls.clearHistory()}
      />
    </div>
  )
}

function QueueHeading({ id, children, detail, action }: { id: string; children: ReactNode; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 pointer-coarse:h-11 items-center gap-2 px-2">
      <h3 id={id} className={labelClass}>{children}</h3>
      {detail && <span className="text-xs tabular text-muted-foreground">{detail}</span>}
      {action && <span className="ml-auto flex">{action}</span>}
    </div>
  )
}

function ClearButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="-mr-1.5 h-6 rounded-md px-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      Clear
    </button>
  )
}

type QueueRowProps = {
  item: QueueItem
  /** Why playback stopped on the current entry: the one held in an outage does not read as unavailable. */
  outage?: SessionOutage | null
  current?: boolean
  playing?: boolean
  /** Playing and not heard yet (`PlayerState.waiting`): the current row spins. */
  waiting?: boolean
  faded?: boolean
  onPlay?: () => void
  children?: ReactNode
  rowButton?: ComponentPropsWithRef<'button'>
}

/**
 * A song in the queue. Songs still being fetched look like any other: only the current one,
 * while its music is on its way, shows the spinner. One that could not be had is gray, says
 * "Not available" and does not play.
 */
function QueueRow({ item, current, playing = false, waiting = false, outage = null, faded, onPlay: play, children, rowButton }: QueueRowProps) {
  const { track, entry } = item
  const library = useLibrary()
  const failed = readsUnavailable(entry, outage)
  const loading = current && (waiting || entry.state === 'preparing')
  const onPlay = failed ? undefined : play
  const body = (
    <>
      {/* Faded rows (history, autoplay) fade their artwork only: their words stay readable. */}
      <div className={cn('relative size-9 shrink-0 transition-opacity', faded && 'opacity-60 group-hover/queue:opacity-100 group-focus-within/queue:opacity-100')}>
        <Cover artwork={track.album?.artwork ?? null} size={96} dimmed={failed} className="size-9 rounded-[5px]" />
        {current && (
          <div className="absolute inset-0 flex items-center justify-center rounded-[5px] bg-black/50">
            {loading ? <Spinner label="Loading" className="size-4 text-white" /> : <Equalizer playing={playing} className="h-3 text-white" />}
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1 text-left">
        <span title={track.title} className={cn('block truncate text-sm font-medium', failed && 'text-muted-foreground')}>{track.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{failed ? UNAVAILABLE_LABEL : track.artistCredit}</span>
      </span>
    </>
  )
  return (
    <div title={failed ? UNAVAILABLE_LABEL : undefined} className={cn('group/queue flex h-12 items-center rounded-lg pr-1 transition-colors', onPlay && 'hover:bg-accent/60')}>
      {onPlay || rowButton
        ? <button type="button" aria-label={onPlay ? `Play ${track.title}` : track.title} onClick={onPlay} {...rowButton} className={cn('flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', rowButton?.className)}>{body}</button>
        : <div className="flex min-w-0 flex-1 items-center gap-3 px-2">{body}</div>}
      {/*
        * Every song row has its heart, here as anywhere, and it never gives way to a narrow panel:
        * the title is what truncates. Unsaved, it waits for the row's hover where a pointer hovers.
        */}
      <SaveHeart
        id={track.id}
        liked={track.liked}
        onToggle={() => library.setSaved({ type: 'track', id: track.id, title: track.title }, !track.liked)}
        title={track.title}
        tooltip={false}
        size="sm"
        className={cn('pointer-coarse:size-11', !track.liked && 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/queue:opacity-100 md:pointer-fine:group-focus-within/queue:opacity-100')}
      />
      {children}
    </div>
  )
}

/** How close to the scroller's top or bottom edge a dragged row starts it scrolling, in px. */
const AUTOSCROLL_EDGE = 48
/** How far it scrolls per frame with the pointer at the very edge, in px. */
const AUTOSCROLL_SPEED = 14

/** The nearest ancestor that scrolls vertically: the queue panel's scroll area, or Now Playing's pane. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

type SortableQueueProps = {
  items: QueueItem[]
  onMove: (entryId: string, toIndex: number) => void
  onRemove: (entryId: string) => void
  onPlay: (entryId: string) => void
}

const DRAG_THRESHOLD = 6
const TOUCH_HOLD_MS = 350

type QueuePointer = {
  entryId: string
  pointerId: number
  button: HTMLButtonElement
  startX: number
  startY: number
  y: number
  scroller: HTMLElement | null
  startScroll: number
  touch: boolean
  active: boolean
  timer?: number
}

/** Drag the song row itself, or focus it and move it with the arrow keys. */
export function SortableQueue({ items, onMove, onRemove, onPlay }: SortableQueueProps) {
  const [drag, setDrag] = useState<{ entryId: string; offset: number } | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const pointer = useRef<QueuePointer | null>(null)
  const suppressClick = useRef(false)
  const dragging = drag !== null
  const [announcement, setAnnouncement] = useState('')
  const helpId = useId()
  const refocus = useRef<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const dropPositions = useRef<Map<Element, number> | null>(null)
  const origin = drag ? items.findIndex(item => item.entry.id === drag.entryId) : -1
  const target = drag && origin >= 0 ? dropIndex(origin, drag.offset, rowHeight, items.length) : -1

  useLayoutEffect(() => {
    if (drag || !dropPositions.current) return
    const positions = dropPositions.current
    dropPositions.current = null
    // The DOM is now in queue order. Animate from where each row was actually painted before the drop.
    const offsets = [...positions].flatMap(([row, top]) => {
      if (!row.isConnected) return []
      const delta = top - row.getBoundingClientRect().top
      return Math.abs(delta) > 0.5 ? [{ row, delta }] : []
    })
    for (const { row, delta } of offsets) {
      const animation = row.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], {
        duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      })
      if (animation) animation.id = 'queue-drop'
    }
  }, [drag, items])

  // A moved row's DOM node can lose focus as it is reinserted; give it back.
  useEffect(() => {
    if (!refocus.current) return
    buttons.current.get(refocus.current)?.focus()
    refocus.current = null
  }, [items])

  useEffect(() => {
    const element = list.current
    // A swipe scrolls normally until a long press has picked up a song.
    const preventScroll = (event: TouchEvent) => {
      if (pointer.current?.active && event.cancelable) event.preventDefault()
    }
    element?.addEventListener('touchmove', preventScroll, { passive: false })
    return () => {
      element?.removeEventListener('touchmove', preventScroll)
      window.clearTimeout(pointer.current?.timer)
    }
  }, [])

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

  const offsetOf = (at: QueuePointer) => at.y - at.startY + (at.scroller?.scrollTop ?? 0) - at.startScroll

  const beginDrag = (at: QueuePointer) => {
    if (pointer.current !== at || !at.button.isConnected) return
    for (const row of list.current?.children ?? []) {
      row.getAnimations?.().find(animation => animation.id === 'queue-drop')?.cancel()
    }
    at.active = true
    at.button.setPointerCapture(at.pointerId)
    setDrag({ entryId: at.entryId, offset: offsetOf(at) })
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, entryId: string) => {
    if (event.button !== 0 || pointer.current || items.length < 2) return
    const scroller = scrollParent(list.current)
    const at: QueuePointer = {
      entryId, pointerId: event.pointerId, button: event.currentTarget,
      startX: event.clientX, startY: event.clientY, y: event.clientY,
      scroller, startScroll: scroller?.scrollTop ?? 0, touch: event.pointerType === 'touch', active: false,
    }
    pointer.current = at
    if (at.touch) at.timer = window.setTimeout(() => beginDrag(at), TOUCH_HOLD_MS)
  }

  const endDrag = (event: PointerEvent, drop = false) => {
    const at = pointer.current
    if (!at || at.pointerId !== event.pointerId) return
    pointer.current = null
    window.clearTimeout(at.timer)
    if (!at.active) return
    suppressClick.current = true
    if (list.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dropPositions.current = new Map(Array.from(list.current.children, row => [row, row.getBoundingClientRect().top]))
    }
    setDrag(null)
    if (!drop) return
    const from = items.findIndex(item => item.entry.id === at.entryId)
    if (from < 0) return
    const to = dropIndex(from, offsetOf(at), rowHeight, items.length)
    if (to !== from) move(items[from], to)
  }

  const onPointerMove = (event: PointerEvent) => {
    const at = pointer.current
    if (!at || at.pointerId !== event.pointerId) return
    at.y = event.clientY
    if (at.active) {
      setDrag({ entryId: at.entryId, offset: offsetOf(at) })
    } else if (Math.hypot(event.clientX - at.startX, event.clientY - at.startY) >= DRAG_THRESHOLD) {
      if (at.touch) endDrag(event)
      else beginDrag(at)
    }
  }

  // Held near the top or bottom of the queue, the list scrolls, so a row can go anywhere.
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    const step = () => {
      const at = pointer.current
      const scroller = at?.scroller
      if (at && scroller) {
        const box = scroller.getBoundingClientRect()
        const into = at.y < box.top + AUTOSCROLL_EDGE ? at.y - (box.top + AUTOSCROLL_EDGE) : at.y > box.bottom - AUTOSCROLL_EDGE ? at.y - (box.bottom - AUTOSCROLL_EDGE) : 0
        const by = Math.round((Math.max(-AUTOSCROLL_EDGE, Math.min(AUTOSCROLL_EDGE, into)) / AUTOSCROLL_EDGE) * AUTOSCROLL_SPEED)
        const before = scroller.scrollTop
        if (by) scroller.scrollTop = before + by
        if (scroller.scrollTop !== before) setDrag(current => current && { ...current, offset: offsetOf(at) })
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [dragging])
  return (
    <>
      <ul ref={list} className="relative"
        onPointerDownCapture={() => { suppressClick.current = false }}
        onClickCapture={event => {
          if (!suppressClick.current || event.detail === 0) return
          suppressClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerMove={onPointerMove}
        onPointerUp={event => endDrag(event, true)}
        onPointerCancel={event => endDrag(event)}
        onLostPointerCapture={event => endDrag(event)}
        onPointerLeave={event => {
          if (!pointer.current?.active) endDrag(event)
        }}>
        {items.map((item, index) => {
          const held = drag?.entryId === item.entry.id
          let shift = 0
          if (origin >= 0 && !held) {
            if (index > origin && index <= target) shift = -rowHeight
            if (index < origin && index >= target) shift = rowHeight
          }
          return (
            <li
              key={item.entry.id}
              style={{ transform: `translateY(${held ? drag.offset : shift}px)` }}
              className={cn(
                'relative rounded-lg',
                held ? 'z-10 bg-accent shadow-md' : drag && 'motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out',
              )}
            >
              <QueueRow item={item} onPlay={() => onPlay(item.entry.id)} rowButton={{
                ref: element => {
                  if (element) buttons.current.set(item.entry.id, element)
                  else buttons.current.delete(item.entry.id)
                },
                'aria-describedby': helpId,
                'aria-description': `Position ${index + 1} of ${items.length}`,
                onKeyDown: event => onKeyDown(event, index),
                onPointerDown: event => onPointerDown(event, item.entry.id),
                onContextMenu: event => { if (pointer.current?.touch) event.preventDefault() },
                className: cn('select-none [-webkit-touch-callout:none]', items.length > 1 && (held ? 'cursor-grabbing' : 'cursor-grab')),
              }}>
                {/* Without a pointer that hovers, the button is always there to tap. */}
                <IconButton label={`Remove ${item.track.title} from queue`} tooltip={false} size="sm" onClick={() => onRemove(item.entry.id)} className="opacity-0 focus-visible:opacity-100 group-hover/queue:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100">
                  <X />
                </IconButton>
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
        {/* No tooltip: the floating queue puts focus here as it opens, and a tooltip shown on focus would take the first Escape, so closing would need two. */}
        <IconButton label="Close queue" tooltip={false} size="sm" onClick={onClose} className={touchTarget}><X /></IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-4 pt-3"><QueueContent player={player} /></div>
      </ScrollArea>
    </div>
  )
}
