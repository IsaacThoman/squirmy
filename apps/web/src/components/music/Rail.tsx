import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { SectionHeader } from './SectionHeader'

type RailProps = {
  title: string
  href?: string
  /** A rail inside a titled group, such as "Albums" under "In your library". */
  quiet?: boolean
  children: ReactNode
}

/** A titled, horizontally scrolling row, with paging buttons on wide screens while it overflows. */
export function Rail({ title, href, quiet, children }: RailProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })

  const measure = useCallback(() => {
    const element = scroller.current
    if (!element) return
    setEdges({
      start: element.scrollLeft <= 1,
      end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    })
  }, [])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure])

  const page = (direction: 1 | -1) => {
    const element = scroller.current
    element?.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' })
  }

  return (
    <section aria-label={title} className="min-w-0">
      <SectionHeader
        title={title}
        href={href}
        quiet={quiet}
        action={!(edges.start && edges.end) && (
          <div className="hidden md:flex">
            <IconButton label="Scroll back" tooltip={false} size="sm" disabled={edges.start} onClick={() => page(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Scroll forward" tooltip={false} size="sm" disabled={edges.end} onClick={() => page(1)}><ChevronRight /></IconButton>
          </div>
        )}
      />
      {/* The row runs to the page's edges; its padding keeps the cards on the gutter and their focus rings unclipped. */}
      <div
        ref={scroller}
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
  return <div className={wide ? 'w-[min(78vw,22rem)] shrink-0 snap-start' : 'w-36 shrink-0 snap-start sm:w-40 lg:w-44'}>{children}</div>
}
