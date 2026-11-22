import { useEffect, useRef, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { pillClass } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** A page's content, padded to the shell's gutter. Pass a max width for pages of forms and tables. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full px-(--gutter) py-6', className)}>{children}</div>
}

type PageHeaderProps = {
  title: string
  /** Links between a page's sections, as `HeaderLink`s. */
  nav?: ReactNode
  navLabel?: string
  /** Controls: sort, filters, the page's main action. */
  children?: ReactNode
  /** Where the controls go: at the far end (default), or after the title, taking the room there is (a search field). */
  controls?: 'end' | 'fill'
  className?: string
}

/**
 * The bar across the top of a page: its title, its sections and its controls. It stays put while
 * the page scrolls under it, and on phones leaves room for the button that opens the sidebar.
 */
export function PageHeader({ title, nav, navLabel, children, controls = 'end', className }: PageHeaderProps) {
  return (
    <header className={cn('sticky top-0 z-20 flex h-12 shrink-0 items-center gap-4 border-b bg-background/85 px-(--gutter) backdrop-blur-md max-md:pl-12', className)}>
      <h1 dir="auto" className="shrink-0 text-sm font-semibold">{title}</h1>
      {nav && <HeaderNav label={navLabel ?? `${title} sections`}>{nav}</HeaderNav>}
      {children && <div className={cn('flex min-w-0 items-center gap-2', controls === 'fill' ? 'flex-1' : 'ml-auto')}>{children}</div>}
    </header>
  )
}

/** How far the section links fade out at an edge they are cut off at. */
const FADE = '1.5rem'

/**
 * The section links. When there are more than fit (a phone), they scroll sideways, fade out at the
 * edge that hides some, and bring the current section into view.
 */
function HeaderNav({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    const nav = ref.current
    if (!nav) return
    // Drawn straight onto the element: it changes on every scroll, and nothing else depends on it.
    const update = () => {
      const end = nav.scrollWidth - nav.clientWidth
      nav.style.setProperty('--fade-start', nav.scrollLeft > 1 ? FADE : '0px')
      nav.style.setProperty('--fade-end', nav.scrollLeft < end - 1 ? FADE : '0px')
    }
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]')
    if (current) {
      const area = nav.getBoundingClientRect()
      const link = current.getBoundingClientRect()
      // A fade's width of room beside it, so it is not read as cut off.
      if (link.right > area.right) nav.scrollLeft += link.right - area.right + 24
      else if (link.left < area.left) nav.scrollLeft -= area.left - link.left + 24
    }
    update()
    nav.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(nav)
    return () => {
      nav.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [pathname])

  return (
    <nav
      ref={ref}
      aria-label={label}
      // The padding keeps the focus ring of the first and last link inside the scrolling area.
      className="scrollbar-none -mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-1 [--fade-end:0px] [--fade-start:0px] [mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%-var(--fade-end)),transparent)]"
    >
      {children}
    </nav>
  )
}

/** A section link in a page header. `count` puts a small number beside it: open reviews, say. */
export function HeaderLink({ to, end, count, children }: { to: string; end?: boolean; count?: number; children: string }) {
  return (
    <NavLink to={to} end={end} className={pillClass}>
      {children}
      {count ? (
        <>
          <span aria-hidden className="min-w-4 rounded-full bg-primary px-1 text-center text-[11px] font-medium leading-4 tabular text-primary-foreground">{count > 99 ? '99+' : count}</span>
          <span className="sr-only">, {count} open</span>
        </>
      ) : null}
    </NavLink>
  )
}

/** The large title of a page that has no header bar. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 dir="auto" className={cn('text-2xl font-semibold tracking-tight', className)}>{children}</h1>
}
