import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
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
  /** Controls on the right: sort, filters, the page's main action. */
  children?: ReactNode
  className?: string
}

/**
 * The bar across the top of a page: its title, its sections and its controls. It stays put while
 * the page scrolls under it, and on phones leaves room for the button that opens the sidebar.
 */
export function PageHeader({ title, nav, navLabel, children, className }: PageHeaderProps) {
  return (
    <header className={cn('sticky top-0 z-20 flex h-12 shrink-0 items-center gap-4 border-b bg-background/85 px-(--gutter) backdrop-blur-md max-md:pl-12', className)}>
      <h1 className="shrink-0 text-sm font-semibold">{title}</h1>
      {nav && <nav aria-label={navLabel ?? `${title} sections`} className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{nav}</nav>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>}
    </header>
  )
}

/** A section link in a page header. `count` puts a small number beside it: open reviews, say. */
export function HeaderLink({ to, end, count, children }: { to: string; end?: boolean; count?: number; children: string }) {
  return (
    <NavLink to={to} end={end} className={pillClass}>
      {children}
      {count ? <span aria-label={`, ${count} open`} className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 tabular text-primary-foreground">{count > 99 ? '99+' : count}</span> : null}
    </NavLink>
  )
}

/** The large title of a page that has no header bar. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn('text-2xl font-semibold tracking-tight', className)}>{children}</h1>
}
