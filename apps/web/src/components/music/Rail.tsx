import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { SectionHeader } from './SectionHeader'

/** A titled, horizontally scrolling row with paging buttons on wide screens. */
export function Rail({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
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
        action={(
          <div className="hidden gap-1 md:flex">
            <IconButton label="Scroll back" tooltip={false} size="sm" variant="solid" disabled={edges.start} onClick={() => page(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Scroll forward" tooltip={false} size="sm" variant="solid" disabled={edges.end} onClick={() => page(1)}><ChevronRight /></IconButton>
          </div>
        )}
      />
      <div
        ref={scroller}
        onScroll={measure}
        className="-mx-(--gutter) flex snap-x snap-mandatory scroll-px-(--gutter) gap-4 overflow-x-auto px-(--gutter) pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </section>
  )
}

/** A fixed-width slot in a rail. */
export function RailItem({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? 'w-[min(78vw,22rem)] shrink-0 snap-start' : 'w-[9.5rem] shrink-0 snap-start md:w-44'}>{children}</div>
}
