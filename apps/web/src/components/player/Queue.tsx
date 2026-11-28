import { contextLabel, readsUnavailable, upNextDetail, upNextTitle, type SessionOutage } from '@squirmy/client-core'
import { Infinity as InfinityIcon, Repeat, Repeat1, Shuffle, X } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { Equalizer } from '@/components/music/Equalizer'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { useVirtualRows } from '@/components/music/use-virtual-rows'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { dropIndex } from '@/lib/reorder'
import { explicitBlocked, UNAVAILABLE_LABEL, unavailableLabel } from '@/lib/catalog'
import { useViewer } from '@/player/on-demand-context'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import type { Player, QueueItem } from '@/player/player-context'
import { SongMenuButton } from './SongMenu'
import { touchTarget } from './Transport'

const rowHeight = 48

const toggleClass = 'inline-flex h-8 pointer-coarse:h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-accent/70 px-3 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90 [&_svg]:size-3.5'

type QueueContentProps = {
  player: Player
  /**
   * Shuffle and repeat in the row of toggles, for where the transport is not right there. Without
   * them, Autoplay's switch is beside its heading.
   */
  modes?: boolean
  /** The queue is on screen. Shown again (as a pane of Now Playing is), it goes back to the song playing. */
  shown?: boolean
  /** The queue as a panel of its own, which this closes; without it, a pane of Now Playing, over its artwork. */
  onClose?: () => void
  /** Before a song's menu goes to its album or artist: Now Playing closes over the page. */
  onNavigate?: () => void
  className?: string
}

/** The lists whose headings the bar above the queue takes over once they scroll away. */
type QueueSection = 'history' | 'next' | 'autoplay'


/**
 * The whole queue, laid out as the iOS app's (and Apple Music's): the history at the top, oldest
 * first, then the song playing with the toggles under it, then Up next ("Continue Playing" while
 * every song in it comes from what is playing) and the Autoplay suggestions. It opens on the song
 * playing, with the history above, out of view until scrolled to; as songs finish and join the
 * history the view keeps its place. The bar above the queue says where it is: "Queue", or, once a
 * list's heading has scrolled away, that list's heading, so the list scrolls under nothing.
 */
export const QueueContent = memo(function QueueContent({ player, modes = true, shown = true, onClose, onNavigate, className }: QueueContentProps) {
  const { state, controls } = player
  // The queue can be on screen twice, as the panel and as a pane of Now Playing.
  const id = useId()
  const [clearingHistory, setClearingHistory] = useState(false)
  const home = useRef<HTMLDivElement>(null)
  const historyList = useRef<HTMLElement>(null)
  const viewHeight = useQueuePlacement(home, historyList, shown, state.history)
  const context = contextLabel(state.context)
  const nextList = useRef<HTMLElement>(null)
  const autoplayList = useRef<HTMLElement>(null)
  const section = useScrolledSection(home, { history: historyList, next: nextList, autoplay: autoplayList })
  const autoplaySwitch = <Switch checked={state.autoplay} onCheckedChange={controls.setAutoplay} aria-label="Autoplay" />
  const upNext = useMemo(() => state.queue.map(item => item.entry), [state.queue])
  const headings: Record<QueueSection, { title: string; detail?: string | null; icon?: ReactNode }> = {
    history: { title: 'History' },
    next: { title: upNextTitle(context, upNext), detail: upNextDetail(context, upNext) ?? 'Songs you add to the queue appear here.' },
    autoplay: {
      title: 'Autoplay',
      detail: state.autoplay ? 'Similar music will keep playing.' : 'Turn on Autoplay to keep listening.',
      icon: <InfinityIcon aria-hidden className={cn('size-4', state.autoplay ? 'text-primary' : 'text-muted-foreground')} />,
    },
  }
  const shownHeading = section ? headings[section] : null
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className={cn('flex h-12 shrink-0 items-center gap-2 border-b', onClose ? 'pl-4 pr-2' : 'border-foreground/10 px-2')}>
        {/* The list scrolled to, in the place of "Queue": its heading in the list says the same to a screen reader. */}
        <div className="grid min-w-0 flex-1 [&>*]:col-start-1 [&>*]:row-start-1">
          <h2 className={cn('self-center text-sm font-semibold transition-opacity duration-150', shownHeading && 'opacity-0')}>Queue</h2>
          {shownHeading && (
            <div aria-hidden className="min-w-0">
              <div className="flex items-center gap-1.5">
                {shownHeading.icon}
                <p className="truncate text-sm font-semibold">{shownHeading.title}</p>
              </div>
              {shownHeading.detail && <p className="truncate text-xs text-muted-foreground">{shownHeading.detail}</p>}
            </div>
          )}
        </div>
        {/* No tooltip: the floating queue puts focus here as it opens, and a tooltip shown on focus would take the first Escape, so closing would need two. */}
        {onClose && <IconButton label="Close queue" tooltip={false} size="sm" onClick={onClose} className={touchTarget}><X /></IconButton>}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {/* The queue keeps its own place as the history grows above it (`useQueuePlacement`); the browser's scroll anchoring would move it twice. */}
        <div className={cn('flex flex-col pb-4 [overflow-anchor:none]', onClose && 'px-2')}>
          {state.history.length > 0 && (
            <section ref={historyList} aria-labelledby={`${id}-history`} className="pb-3">
              <QueueHeading id={`${id}-history`} action={<ClearButton label="Clear history" onClick={() => setClearingHistory(true)} />}>
                History
              </QueueHeading>
              <QueueRows items={state.history} onPlay={controls.playEntry} onNavigate={onNavigate} />
            </section>
          )}

          {/* At least a screen from the song playing down, so the queue can rest on it with the history above, however short Up next is. */}
          <div style={{ minHeight: state.history.length ? viewHeight : undefined }}>
            <div ref={home}>
              {state.current && (
                <section aria-label="Now playing">
                  <QueueRow item={state.current} current playing={state.playing} waiting={state.waiting} outage={state.outage} onNavigate={onNavigate} />
                </section>
              )}
            </div>
            {modes && (
              <div className="flex h-11 items-center gap-2 px-2 pointer-coarse:h-14">
                <button type="button" aria-pressed={state.shuffle} onClick={() => controls.setShuffle(!state.shuffle)} className={toggleClass}>
                  <Shuffle aria-hidden />Shuffle
                </button>
                <button type="button" aria-pressed={state.repeat !== 'off'} onClick={controls.cycleRepeat} className={toggleClass}>
                  {state.repeat === 'one' ? <Repeat1 aria-hidden /> : <Repeat aria-hidden />}{state.repeat === 'one' ? 'Repeat one' : 'Repeat'}
                </button>
                <button type="button" aria-pressed={state.autoplay} onClick={() => controls.setAutoplay(!state.autoplay)} className={toggleClass}>
                  <InfinityIcon aria-hidden />Autoplay
                </button>
              </div>
            )}

            <section ref={nextList} aria-labelledby={`${id}-next`} className="pt-2">
              <QueueHeading
                id={`${id}-next`}
                detail={headings.next.detail}
                action={state.queue.length > 0 && <ClearButton label="Clear queue" onClick={controls.clearQueue} />}
              >
                {headings.next.title}
              </QueueHeading>
              {state.queue.length > 0 && <SortableQueue items={state.queue} onMove={controls.moveEntry} onRemove={controls.removeEntry} onPlay={controls.playEntry} onNavigate={onNavigate} />}
            </section>

            <section ref={autoplayList} aria-labelledby={`${id}-autoplay`} className="pt-3">
              <QueueHeading
                id={`${id}-autoplay`}
                icon={headings.autoplay.icon}
                detail={headings.autoplay.detail}
                action={!modes && autoplaySwitch}
              >
                Autoplay
              </QueueHeading>
              {state.autoplay && <QueueRows items={state.autoplayQueue} onPlay={controls.playEntry} onNavigate={onNavigate} />}
            </section>
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
        </div>
      </ScrollArea>
    </div>
  )
})

/**
 * Which list the queue is scrolled into: the one whose heading has scrolled up out of view while
 * some of its songs are still in view. Null on the song playing and the toggles, and above.
 */
function useScrolledSection(inside: RefObject<HTMLElement | null>, lists: Record<QueueSection, RefObject<HTMLElement | null>>) {
  const [section, setSection] = useState<QueueSection | null>(null)
  // The lists' refs never change, so those of the first render serve.
  const latest = useRef(lists)
  useEffect(() => {
    const scroller = scrollParent(inside.current, { overflowing: false })
    if (!scroller) return
    let frame = 0
    const measure = () => {
      frame = 0
      const top = scroller.getBoundingClientRect().top + 0.5
      let found: QueueSection | null = null
      for (const [key, ref] of Object.entries(latest.current) as [QueueSection, RefObject<HTMLElement | null>][]) {
        const list = ref.current
        const heading = list?.firstElementChild
        if (list && heading && heading.getBoundingClientRect().bottom <= top && list.getBoundingClientRect().bottom > top) found = key
      }
      setSection(found)
    }
    const onScroll = () => { frame ||= requestAnimationFrame(measure) }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [inside])
  return section
}

/**
 * Where the queue scrolls to. Each time it is shown it rests on the song playing (`home`), with
 * the history above out of view. While the song playing is in view or scrolled past, a song that
 * finishes and joins the history moves everything down by its row, and the view follows, so the
 * reader keeps their place; up in the history, nothing moves.
 */
function useQueuePlacement(home: RefObject<HTMLElement | null>, history: RefObject<HTMLElement | null>, shown: boolean, entries: readonly QueueItem[]) {
  const historyHeight = useRef<number | null>(null)
  // How tall the scroller's view is: the part from the song playing down is at least that.
  const [viewHeight, setViewHeight] = useState(0)
  useLayoutEffect(() => {
    const scroller = scrollParent(home.current, { overflowing: false })
    if (!scroller) return
    const measure = () => setViewHeight(scroller.clientHeight)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(scroller)
    return () => observer?.disconnect()
  }, [home])
  // Placed once each time it is shown, after the view is measured: until then the part below the song playing may be too short to rest on it.
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (!shown) {
      placed.current = false
      return
    }
    const scroller = scrollParent(home.current, { overflowing: false })
    if (placed.current || !scroller || !home.current || !viewHeight) return
    placed.current = true
    scroller.scrollTop += home.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, [home, shown, viewHeight])
  useLayoutEffect(() => {
    const height = history.current?.offsetHeight ?? 0
    const before = historyHeight.current
    historyHeight.current = height
    const grown = before === null ? 0 : height - before
    const scroller = scrollParent(home.current, { overflowing: false })
    if (!grown || !scroller || !home.current) return
    // Where the song playing was drawn before the history grew under it.
    const homeTop = home.current.getBoundingClientRect().top - grown
    if (homeTop <= scroller.getBoundingClientRect().top + 1) scroller.scrollTop += grown
  }, [home, history, entries])
  return viewHeight
}

function QueueHeading({ id, children, detail, action, icon }: {
  id: string; children: ReactNode; detail?: string | null; action?: ReactNode; icon?: ReactNode
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {icon}
          <h3 id={id} className="truncate text-sm font-semibold">{children}</h3>
        </div>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      {action && <span className="flex shrink-0 items-center">{action}</span>}
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
  /** The entry's place in Up next, for its menu's moves. */
  queued?: { index: number; count: number }
  onNavigate?: () => void
  children?: ReactNode
  rowButton?: ComponentPropsWithRef<'button'>
}

/** A row's own buttons beyond the heart wait for its hover where a pointer hovers, and stay while their menu is open. */
const revealed = 'opacity-0 focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/queue:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100'

/**
 * A song in the queue. Songs still being fetched look like any other: only the current one,
 * while its music is on its way, shows the spinner. One that could not be had is gray, says
 * "Not available" and does not play.
 */
function QueueRow({ item, current, playing = false, waiting = false, outage = null, faded, onPlay: play, queued, onNavigate, children, rowButton }: QueueRowProps) {
  const { track, entry } = item
  const library = useLibrary()
  const viewer = useViewer()
  // An explicit song queued before explicit content was turned off is gray too: the server refuses it.
  const failed = readsUnavailable(entry, outage) || explicitBlocked(track, viewer)
  const failedText = readsUnavailable(entry, outage) ? UNAVAILABLE_LABEL : unavailableLabel(track, viewer)
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
        <span className="block truncate text-xs text-muted-foreground">{failed ? failedText : track.artistCredit}</span>
      </span>
    </>
  )
  return (
    <div title={failed ? failedText : undefined} className={cn('group/queue flex h-12 items-center rounded-lg pr-1 transition-colors', onPlay && 'hover:bg-accent/60')}>
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
      <SongMenuButton track={track} unavailable={failed} queued={queued && { entryId: entry.id, ...queued }} onNavigate={onNavigate} className={current ? 'pointer-coarse:size-11' : revealed} />
      {children}
    </div>
  )
}

/** How close to the scroller's top or bottom edge a dragged row starts it scrolling, in px. */
const AUTOSCROLL_EDGE = 48
/** How far it scrolls per frame with the pointer at the very edge, in px. */
const AUTOSCROLL_SPEED = 14

/**
 * The nearest ancestor that scrolls vertically: the queue panel's scroll area, or Now Playing's
 * pane. Unless `overflowing` is false, only one with more to scroll than it shows.
 */
function scrollParent(element: HTMLElement | null, { overflowing = true } = {}): HTMLElement | null {
  // A scroll area says it scrolls only once its scrollbar has mounted, after the queue's first layout.
  const viewport = element?.closest<HTMLElement>('[data-radix-scroll-area-viewport], [data-now-playing-scroll]')
  if (viewport && (!overflowing || viewport.scrollHeight > viewport.clientHeight)) return viewport
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && (!overflowing || node.scrollHeight > node.clientHeight)) return node
  }
  return null
}

type SortableQueueProps = {
  items: QueueItem[]
  onMove: (entryId: string, toIndex: number) => void
  onRemove: (entryId: string) => void
  onPlay: (entryId: string) => void
  onNavigate?: () => void
}

type QueueRowsProps = Pick<SortableQueueProps, 'items' | 'onPlay' | 'onNavigate'>

function useQueueRows(items: QueueItem[], pinned?: number) {
  const list = useRef<HTMLUListElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [focusedId, setFocusedId] = useState<string>()
  const indexes = useMemo(() => new Map(items.map(({ entry }, index) => [entry.id, index])), [items])
  const getItemKey = useCallback((index: number) => items[index].entry.id, [items])
  useLayoutEffect(() => setScroller(scrollParent(list.current, { overflowing: false })), [])
  const rows = useVirtualRows({
    list, scroller, count: items.length, rowHeight, focused: focusedId === undefined ? undefined : indexes.get(focusedId), pinned, getItemKey,
  })
  return { list, rows, setFocusedId, scroller }
}

const QueueRows = memo(function QueueRows({ items, onPlay, onNavigate }: QueueRowsProps) {
  const { list, rows, setFocusedId } = useQueueRows(items)
  return (
    <ul ref={list} className="relative" style={{ height: rows.getTotalSize() }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
      }}>
      {rows.getVirtualItems().map(({ index, key }) => {
        const item = items[index]
        return (
          <li key={key} className="absolute inset-x-0" style={{ top: index * rowHeight }}
            aria-posinset={index + 1} aria-setsize={items.length}
            onFocus={() => setFocusedId(item.entry.id)}>
            <QueueRow item={item} onPlay={() => onPlay(item.entry.id)} onNavigate={onNavigate} faded />
          </li>
        )
      })}
    </ul>
  )
})

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
export const SortableQueue = memo(function SortableQueue({ items, onMove, onRemove, onPlay, onNavigate }: SortableQueueProps) {
  const [drag, setDrag] = useState<{ entryId: string; offset: number } | null>(null)
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
  const { list, rows, setFocusedId, scroller } = useQueueRows(items, origin)

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
    const button = buttons.current.get(refocus.current)
    // Use the actual row once the optimistic move updates its position, including across a window edge.
    button?.focus()
    button?.scrollIntoView?.({ block: 'nearest' })
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
  }, [list])

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

  // The rows' handlers, the same functions on every render, so a row the drag does not move is not rendered again.
  const latest = useRef({ onKeyDown, onPointerDown, onPlay, onRemove, onNavigate })
  useLayoutEffect(() => { latest.current = { onKeyDown, onPointerDown, onPlay, onRemove, onNavigate } })
  const [actions] = useState<SortableRowActions>(() => ({
    register: (entryId, element) => {
      if (element) buttons.current.set(entryId, element)
      else buttons.current.delete(entryId)
    },
    onKeyDown: (event, index) => latest.current.onKeyDown(event, index),
    onPointerDown: (event, entryId) => latest.current.onPointerDown(event, entryId),
    onContextMenu: event => { if (pointer.current?.touch) event.preventDefault() },
    onPlay: entryId => latest.current.onPlay(entryId),
    onRemove: entryId => latest.current.onRemove(entryId),
    onNavigate: () => latest.current.onNavigate?.(),
  }))

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
      <ul ref={list} className="relative" style={{ height: rows.getTotalSize() }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
        }}
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
        {rows.getVirtualItems().map(({ index, key }) => {
          const item = items[index]
          const held = drag?.entryId === item.entry.id
          let shift = 0
          if (origin >= 0 && !held) {
            if (index > origin && index <= target) shift = -rowHeight
            if (index < origin && index >= target) shift = rowHeight
          }
          return <SortableQueueRow key={key} item={item} index={index} count={items.length} y={held ? drag.offset : shift} held={held} dragging={dragging} helpId={helpId} actions={actions} onFocusRow={setFocusedId} />
        })}
      </ul>
      <p id={helpId} className="sr-only">Use the up and down arrow keys to move this song.</p>
      <p aria-live="polite" className="sr-only">{announcement}</p>
    </>
  )
})

type SortableRowActions = {
  register: (entryId: string, element: HTMLButtonElement | null) => void
  onKeyDown: (event: KeyboardEvent, index: number) => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, entryId: string) => void
  onContextMenu: (event: MouseEvent) => void
  onPlay: (entryId: string) => void
  onRemove: (entryId: string) => void
  onNavigate: () => void
}

type SortableQueueRowProps = {
  item: QueueItem
  index: number
  count: number
  /** How far the row is drawn from its place: the held row follows the pointer, the others make room. */
  y: number
  held: boolean
  dragging: boolean
  helpId: string
  actions: SortableRowActions
  onFocusRow: (entryId: string) => void
}

/** A song of `SortableQueue`. A drag renders only the rows it moves, not the whole queue on every pointer move. */
const SortableQueueRow = memo(function SortableQueueRow({ item, index, count, y, held, dragging, helpId, actions, onFocusRow }: SortableQueueRowProps) {
  const entryId = item.entry.id
  return (
    <li
      aria-posinset={index + 1}
      aria-setsize={count}
      onFocus={() => onFocusRow(entryId)}
      style={{ top: index * rowHeight, transform: `translateY(${y}px)` }}
      className={cn(
        'absolute inset-x-0 rounded-lg',
        held ? 'z-10 bg-accent shadow-md' : dragging && 'motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out',
      )}
    >
      <QueueRow item={item} onPlay={() => actions.onPlay(entryId)} queued={{ index, count }} onNavigate={actions.onNavigate} rowButton={{
        ref: element => actions.register(entryId, element),
        'aria-describedby': helpId,
        'aria-description': `Position ${index + 1} of ${count}`,
        onKeyDown: event => actions.onKeyDown(event, index),
        onPointerDown: event => actions.onPointerDown(event, entryId),
        onContextMenu: actions.onContextMenu,
        className: cn('select-none [-webkit-touch-callout:none]', count > 1 && (held ? 'cursor-grabbing' : 'cursor-grab')),
      }}>
        {/* Without a pointer that hovers, the button is always there to tap. */}
        <IconButton label={`Remove ${item.track.title} from queue`} tooltip={false} size="sm" onClick={() => actions.onRemove(entryId)} className={revealed}>
          <X />
        </IconButton>
      </QueueRow>
    </li>
  )
})

/** The queue under its title bar. The shell docks it beside the page or floats it over the page. */
export function QueuePanel({ player, onClose }: { player: Player; onClose: () => void }) {
  return <QueueContent player={player} onClose={onClose} className="h-full w-full" />
}
