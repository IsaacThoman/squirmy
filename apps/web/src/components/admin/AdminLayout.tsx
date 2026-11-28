import { ChevronDown } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { HeaderLink, Page, PageHeader } from '@/components/layout/Page'
import { DropdownMenu } from '@/components/ui/menu'
import { pillClass } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { fitSections } from './admin-sections'

const sections = [
  { to: '/admin/library', label: 'Library' },
  { to: '/admin/uploads', label: 'Uploads' },
  { to: '/admin/reviews', label: 'Review queue' },
  { to: '/admin/organize', label: 'Organize' },
  { to: '/admin/search-index', label: 'Search index' },
  { to: '/admin/providers', label: 'Providers' },
  { to: '/admin/users', label: 'Users & invites' },
  { to: '/admin/sharing', label: 'Sharing' },
  { to: '/admin/settings', label: 'Server settings' },
  { to: '/admin/jobs', label: 'Jobs' },
]

type Counts = Record<string, number | undefined>

/** `counts` puts a small number beside a section, keyed by its path: open reviews, say. `version` is the server's. */
export function AdminLayout({ counts, version }: { counts?: Counts; version?: string }) {
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Admin" controls="fill">
        <AdminNav counts={counts} />
      </PageHeader>
      <Page className="max-w-6xl flex-1"><Outlet /></Page>
      {version && <p className="mx-auto w-full max-w-6xl px-(--gutter) pb-6 text-xs text-muted-foreground">Squirmy {version}</p>}
    </div>
  )
}

const everySection = sections.map((_, index) => index)

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, index) => value === b[index])

/**
 * The admin sections in one row. Those that do not fit (a narrow window, a phone) are under a
 * More menu at its end, so every section is one click away and none hides past an edge. The
 * links are measured in a hidden copy of the row, which keeps its size whichever links show.
 */
function AdminNav({ counts }: { counts?: Counts }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const area = useRef<HTMLElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const current = sections.findIndex(section => pathname === section.to || pathname.startsWith(`${section.to}/`))
  const [shown, setShown] = useState<number[]>(everySection)

  useLayoutEffect(() => {
    const nav = area.current
    const copy = ruler.current
    if (!nav || !copy) return
    const fit = () => {
      const widths = [...copy.children].map(child => child.getBoundingClientRect().width)
      const more = widths.pop() ?? 0
      const style = getComputedStyle(nav)
      const room = nav.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      // Before layout (and in tests) there is nothing to measure: every section shows.
      const next = room > 0 ? fitSections(widths, more, room, current) : everySection
      setShown(previous => (same(previous, next) ? previous : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(nav)
    observer.observe(copy)
    return () => observer.disconnect()
  }, [current])

  const hidden = sections.filter((_, index) => !shown.includes(index))
  const hiddenCount = hidden.reduce((total, section) => total + (counts?.[section.to] ?? 0), 0)
  return (
    // The padding keeps the focus ring of the first and last link inside the header.
    <nav ref={area} aria-label="Admin sections" className="relative -mx-1 flex min-w-0 flex-1 items-center gap-1 px-1 py-1">
      {shown.map(index => {
        const { to, label } = sections[index]!
        return <HeaderLink key={to} to={to} count={counts?.[to]}>{label}</HeaderLink>
      })}
      {hidden.length > 0 && (
        <DropdownMenu
          trigger={(
            <button type="button" className={cn(pillClass, 'data-[state=open]:bg-accent data-[state=open]:text-foreground')}>
              More
              {hiddenCount > 0 && <><Count value={hiddenCount} /><span className="sr-only">, {hiddenCount} open</span></>}
              <ChevronDown aria-hidden className="-mr-1 size-3.5" />
            </button>
          )}
          entries={hidden.map(({ to, label }) => ({
            label: counts?.[to] ? `${label} (${counts[to]})` : label,
            onSelect: () => navigate(to),
          }))}
        />
      )}
      {/* Never seen or read: every link and the More button at their own widths, for measuring. */}
      <div ref={ruler} aria-hidden inert className="pointer-events-none invisible absolute left-0 top-0 flex w-max">
        {sections.map(({ to, label }) => <span key={to} className={pillClass}>{label}{counts?.[to] ? <Count value={counts[to]!} /> : null}</span>)}
        <span className={pillClass}>More<ChevronDown className="-mr-1 size-3.5" /></span>
      </div>
    </nav>
  )
}

/** The small number beside a section, as `HeaderLink` draws it. */
function Count({ value }: { value: number }) {
  return <span aria-hidden className="min-w-4 rounded-full bg-primary px-1 text-center text-[11px] font-medium leading-4 tabular text-primary-foreground">{value > 99 ? '99+' : value}</span>
}

/** The top of an admin page: what it is for, and its main actions. */
export function AdminHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  )
}

/** A number with a label, for the top of admin pages. */
export function Stat({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular tracking-tight">{value}</p>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

/** Kept here for the admin pages that import it; it lives with the other dialog parts. */
export { DialogForm } from '@/components/ui/dialog'
