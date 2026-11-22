import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { SectionHeader } from './SectionHeader'

/** A titled, horizontally scrolling row with paging buttons on wide screens. */
export function Rail({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const itemCount = Children.count(children)

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
  }, [itemCount, measure])

  const page = (direction: 1 | -1) => {
    const element = scroller.current
    element?.scrollBy({ left: direction * element.clientWidth * 0.85, behavior: 'smooth' })
  }

  return (
    <section aria-label={title} className="min-w-0">
      <SectionHeader
        title={title}
        href={href}
        action={edges.start && edges.end ? undefined : (
          <div className="hidden gap-1 rounded-lg border border-stroke bg-sheet md:flex">
            <IconButton label="Scroll back" tooltip={false} size="sm" className="rounded-md" disabled={edges.start} onClick={() => page(-1)}><ChevronLeft /></IconButton>
            <IconButton label="Scroll forward" tooltip={false} size="sm" className="rounded-md" disabled={edges.end} onClick={() => page(1)}><ChevronRight /></IconButton>
          </div>
        )}
      />
      <div
        ref={scroller}
        onScroll={measure}
        className="-mx-(--gutter) flex snap-x snap-mandatory scroll-px-(--gutter) gap-4 overflow-x-auto px-(--gutter) pt-1 pb-2 [scrollbar-width:none] md:gap-5 [&::-webkit-scrollbar]:hidden"
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
