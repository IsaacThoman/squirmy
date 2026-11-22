import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useScrollContainer } from '@/components/layout/scroll-context'
import { useEndReached } from './use-end-reached'

// The same measures as `CardGrid`: 16px between columns, 24px between rows, cards at least 160px wide.
const gap = 16
const rowGap = 24
const minWidth = 160
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
  })
  useEndReached(virtualizer.getVirtualItems().at(-1)?.index ?? -1, rows, onEndReached, list ? 10 : 3)

  return (
    <div ref={container} role="list" aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="absolute inset-x-0 top-0 grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingBottom: list ? 0 : rowGap, transform: `translateY(${row.start - layout.margin}px)` }}
        >
          {items.slice(row.index * columns, row.index * columns + columns).map(item => (
            <div key={getKey(item)} role="listitem">{renderItem(item)}</div>
          ))}
        </div>
      ))}
    </div>
  )
}
