import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useScrollContainer } from '@/components/layout/scroll-context'
import { CARD_MIN_WIDTH, useDensity } from '@/lib/density'
import { useEndReached } from './use-end-reached'

// The same measures as `CardGrid`: 16px between columns, 24px between rows, cards at least 160px wide (128px compact).
const gap = 16
const rowGap = 24
/** A card's two lines of text under its artwork. */
const captionHeight = 44
/** A `CollectionRow`, for the list layout. */
const listRowHeight = 56

type VirtualGridProps<T> = {
  items: T[]
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  label: string
  /** Called as the last rows come into view, to load the next page. */
  onEndReached?: () => void
  /** One item a row, for rows rather than cards. */
  list?: boolean
}

/** A card grid (or a list of rows) that renders only the rows near the viewport. For whole-library lists. */
export function VirtualGrid<T>({ items, getKey, renderItem, label, onEndReached, list = false }: VirtualGridProps<T>) {
  const scroller = useScrollContainer()
  const container = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ width: 1024, margin: 0 })

  useLayoutEffect(() => {
    const element = container.current
    if (!element || !scroller) return
    const measure = () => setLayout({
      width: element.clientWidth || 1024,
      margin: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scroller])

  // Rows are measured as they draw, so cards of another size (the display density changed) place themselves again.
  const minWidth = CARD_MIN_WIDTH[useDensity()]
  const columns = list ? 1 : Math.max(2, Math.floor((layout.width + gap) / (minWidth + gap)))
  const cardWidth = (layout.width - gap * (columns - 1)) / columns
  const rows = Math.ceil(items.length / columns)

  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller,
    estimateSize: () => (list ? listRowHeight : cardWidth + captionHeight + rowGap),
    overscan: 3,
    scrollMargin: layout.margin,
    initialRect: { width: 1024, height: 900 },

    // Where the page is now: left at 0, the virtualizer scrolls the page back to the top as it
    // mounts, undoing Back's scroll restoration.
    initialOffset: () => scroller?.scrollTop ?? 0,
  })
  useEndReached(virtualizer.getVirtualItems().at(-1)?.index ?? -1, rows, onEndReached, list ? 10 : 3)

  return (
    <div ref={container} role="list" aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => (
        <GridRow
          key={row.key}
          measure={virtualizer.measureElement}
          index={row.index}
          y={row.start - layout.margin}
          items={items}
          columns={columns}
          list={list}
          getKey={getKey as (item: unknown) => string}
          renderItem={renderItem as (item: unknown) => ReactNode}
        />
      ))}
    </div>
  )
}

type GridRowProps = {
  measure: (element: Element | null) => void
  index: number
  y: number
  items: unknown[]
  columns: number
  list: boolean
  getKey: (item: unknown) => string
  renderItem: (item: unknown) => ReactNode
}

/**
 * One row. The virtualizer renders the grid on every scroll event; rows that only stay where
 * they are, and cards that stay in their row, are not rendered again, so a scroll frame costs
 * the rows coming into view rather than every card on screen.
 */
const GridRow = memo(function GridRow({ measure, index, y, items, columns, list, getKey, renderItem }: GridRowProps) {
  return (
    <div
      ref={measure}
      data-index={index}
      className="absolute inset-x-0 top-0 grid"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingBottom: list ? 0 : rowGap, transform: `translateY(${y}px)` }}
    >
      {items.slice(index * columns, index * columns + columns).map(item => (
        <GridCell key={getKey(item)} item={item} renderItem={renderItem} />
      ))}
    </div>
  )
}, (before, after) => before.measure === after.measure && before.index === after.index && before.y === after.y && before.columns === after.columns
  && before.list === after.list && before.getKey === after.getKey && before.renderItem === after.renderItem
  && sameRow(before.items, after.items, before.index * before.columns, before.columns))

/** Whether a row shows the same items, by identity, so a page loaded further down leaves the rows above alone. */
function sameRow(before: unknown[], after: unknown[], start: number, count: number): boolean {
  if (before === after) return true
  for (let index = start; index < start + count; index += 1) if (before[index] !== after[index]) return false
  return true
}

/** A card, rendered again only when its item or the way items render changes (a resize moves it, not re-renders it). */
const GridCell = memo(function GridCell({ item, renderItem }: { item: unknown; renderItem: (item: unknown) => ReactNode }) {
  return <div role="listitem">{renderItem(item)}</div>
})
