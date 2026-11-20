import { useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useScrollContainer } from '@/components/layout/scroll-context'

const gap = 20
const rowGap = 28
const minWidth = 168

/** A card grid that renders only the rows near the viewport. For whole-library lists. */
export function VirtualGrid<T>({ items, getKey, renderItem, label }: { items: T[]; getKey: (item: T) => string; renderItem: (item: T) => ReactNode; label: string }) {
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

  const columns = Math.max(2, Math.floor((layout.width + gap) / (minWidth + gap)))
  const cardWidth = (layout.width - gap * (columns - 1)) / columns
  const rows = Math.ceil(items.length / columns)

  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller,
    estimateSize: () => cardWidth + 56 + rowGap,
    overscan: 3,
    scrollMargin: layout.margin,
    initialRect: { width: 1024, height: 900 },
  })

  return (
    <div ref={container} role="list" aria-label={label} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="absolute inset-x-0 top-0 grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingBottom: rowGap, transform: `translateY(${row.start - layout.margin}px)` }}
        >
          {items.slice(row.index * columns, row.index * columns + columns).map(item => (
            <div key={getKey(item)} role="listitem">{renderItem(item)}</div>
          ))}
        </div>
      ))}
    </div>
  )
}
