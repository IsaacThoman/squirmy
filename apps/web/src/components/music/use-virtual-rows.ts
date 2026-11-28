import { defaultRangeExtractor, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Fixed-height rows in a scroller shared with headings and other content. */
export function useVirtualRows({
  list, scroller, count, rowHeight, focused, pinned, getItemKey,
}: {
  list: RefObject<HTMLElement | null>
  scroller: HTMLElement | null
  count: number
  rowHeight: number
  focused?: number
  pinned?: number
  getItemKey?: (index: number) => string
}) {
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    if (!scroller || !element) return
    const measure = () => setMargin(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    // A changing header or queue history can move the list without resizing the viewport.
    for (let node: Element | null = element; node && node !== scroller; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) observer.observe(sibling)
    }
    return () => observer.disconnect()
  }, [count, list, scroller])

  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  return useVirtualizer({
    count,
    getScrollElement: () => scroller,
    estimateSize: () => rowHeight,
    getItemKey,
    overscan: 8,
    scrollMargin: margin,
    initialRect: { width: 1024, height: 900 },
    // A pane that is still opening can report an empty viewport before it gets its height.
    observeElementRect: (instance, onRect) => observeElementRect(instance, rect => {
      if (rect.height > 0) onRect(rect)
    }),
    // Keep the shell's Back/Forward scroll restoration, and the queue's placement on Now Playing.
    initialOffset: () => scroller?.scrollTop ?? 0,
    rangeExtractor: range => {
      const indexes = new Set(defaultRangeExtractor(range))
      if (pinned !== undefined && pinned >= 0 && pinned < count) indexes.add(pinned)
      if (focused !== undefined) {
        // The adjacent rows give Tab and Shift+Tab somewhere to go even after manual scrolling.
        for (let index = focused - 1; index <= focused + 1; index++) {
          if (index >= 0 && index < count) indexes.add(index)
        }
      }
      return [...indexes].sort((a, b) => a - b)
    },
  })
}
