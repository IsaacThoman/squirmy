import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useRailScrollMemory } from '@/components/layout/scroll-memory'
import { IconButton } from '@/components/ui/icon-button'
import { scrollBehavior } from '@/lib/motion'
import { SectionHeader } from './SectionHeader'

type RailProps = {
  title: string
  href?: string
  /** A rail inside a titled group, such as "Albums" under "In your library". */
  quiet?: boolean
  children: ReactNode
}

/**
 * The paging buttons are never natively disabled: the one that reaches an end keeps keyboard
 * focus (a disabled button would drop it to the page), says it is unavailable, and does nothing.
 */
const atEnd = 'aria-disabled:pointer-events-none aria-disabled:opacity-40'

/** A titled, horizontally scrolling row, with paging buttons on wide screens while it overflows. */
export function Rail({ title, href, quiet, children }: RailProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  // Back to this page returns the row to where it was left.
  useRailScrollMemory(scroller, title)

  const measure = useCallback(() => {
    if (!scroller) return
    setEdges({
      start: scroller.scrollLeft <= 1,
      end: scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1,
    })
  }, [scroller])

  useEffect(() => {
    if (!scroller) return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller, measure])

  const page = (direction: 1 | -1) => {
    if (!scroller || (direction === 1 ? edges.end : edges.start)) return
    scroller.scrollBy({ left: direction * scroller.clientWidth * 0.85, behavior: scrollBehavior() })
  }

  return (
    <section aria-label={title} className="min-w-0">
      <SectionHeader
        title={title}
        href={href}
        quiet={quiet}
        action={!(edges.start && edges.end) && (
          <div className="hidden md:flex">
            <IconButton label="Scroll back" tooltip={false} size="sm" aria-disabled={edges.start || undefined} className={atEnd} onClick={() => page(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Scroll forward" tooltip={false} size="sm" aria-disabled={edges.end || undefined} className={atEnd} onClick={() => page(1)}><ChevronRight /></IconButton>
          </div>
        )}
      />
      {/* The row runs to the page's edges; its padding keeps the cards on the gutter and their focus rings unclipped. */}
      <div
        ref={setScroller}
        onScroll={measure}
        className="scrollbar-none -mx-(--gutter) -my-2 flex snap-x snap-mandatory scroll-px-(--gutter) gap-4 overflow-x-auto px-(--gutter) py-2"
      >
        {children}
      </div>
    </section>
  )
}

/** A fixed-width slot in a rail. */
export function RailItem({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'w-[min(78vw,22rem)] shrink-0 snap-start' : 'w-36 shrink-0 snap-start sm:w-40 lg:w-44 compact:w-32 compact:sm:w-32 compact:lg:w-36'}>{children}</div>
}
