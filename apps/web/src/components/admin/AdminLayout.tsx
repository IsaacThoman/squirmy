import { Briefcase, DatabaseZap, FolderTree, HardDrive, ListChecks, PlugZap, SlidersHorizontal, Users } from 'lucide-react'
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import type { FormErrors } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/input'

const sections = [
  { to: '/admin/library', label: 'Library', icon: HardDrive },
  { to: '/admin/reviews', label: 'Review queue', icon: ListChecks },
  { to: '/admin/organize', label: 'Organize', icon: FolderTree },
  { to: '/admin/search-index', label: 'Search index', icon: DatabaseZap },
  { to: '/admin/providers', label: 'Providers', icon: PlugZap },
  { to: '/admin/users', label: 'Users & invites', icon: Users },
  { to: '/admin/jobs', label: 'Jobs', icon: Briefcase },
  { to: '/admin/settings', label: 'Server settings', icon: SlidersHorizontal },
]

/** The tab strip shares the shell's scroller so page content and the player keep their usual layout. */
export function AdminLayout({ counts, version }: { counts?: Record<string, number | undefined>; version?: string }) {
  const nav = useRef<HTMLElement>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    const strip = nav.current
    const active = strip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!strip || !active) return
    if (active.offsetLeft < strip.scrollLeft || active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = active.offsetLeft - 12
    }
  }, [pathname])

  return (
    <section className="pb-12 pt-14 md:pt-16">
      <div className="border-t border-stroke bg-sheet">
        <div className="mx-auto flex max-w-7xl flex-wrap items-baseline justify-between gap-2 px-(--gutter) pb-2 pt-5">
          <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
          {version && <span className="text-xs text-quiet">Squirmy {version}</span>}
        </div>
      </div>
      <div className="sticky top-14 z-10 border-b border-stroke bg-sheet md:top-16">
        <nav ref={nav} aria-label="Admin sections" className="relative mx-auto flex max-w-7xl gap-1 overflow-x-auto px-(--gutter) py-2">
          {sections.map(({ to, label, icon: Icon }) => {
            const count = counts?.[to]
            return (
              <NavLink key={to} to={to} className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:font-semibold aria-[current=page]:text-accent">
                <Icon aria-hidden className="size-4" />{label}
                {count ? <span aria-label={`${count} open`} className="min-w-5 rounded-md bg-accent px-1 text-center text-[11px] font-bold leading-5 tabular text-on-accent">{count > 99 ? '99+' : count}</span> : null}
              </NavLink>
            )
          })}
        </nav>
      </div>
      <div className="mx-auto min-w-0 max-w-7xl px-(--gutter) py-6 sm:py-8"><Outlet /></div>
    </section>
  )
}

export function AdminHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-[-0.03em]">{title}</h2>
        {description && <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  )
}

/** A number with a label, for the top of admin pages. */
export function Stat({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular tracking-tight">{value}</p>
      {detail && <div className="mt-0.5 text-xs text-quiet">{detail}</div>}
    </div>
  )
}

/** A dialog's form: its fields, the failure that belongs to no field, then Cancel and submit. */
export function DialogForm({ onSubmit, errors, pending, submitLabel, disabled, children }: { onSubmit: () => void; errors: FormErrors; pending: boolean; submitLabel: string; disabled?: boolean; children: ReactNode }) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {children}
      <FormError message={errors.form} />
      <DialogFooter>
        <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" pending={pending} disabled={disabled}>{submitLabel}</Button>
      </DialogFooter>
    </form>
  )
}
