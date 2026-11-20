import { Briefcase, DatabaseZap, FolderTree, HardDrive, ListChecks, PlugZap, SlidersHorizontal, Users } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import type { FormErrors } from '@/api/errors'
import { Page } from '@/components/layout/Page'
import { PageTitle } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/input'

const groups = [
  {
    label: 'Music',
    sections: [
      { to: '/admin/library', label: 'Library', icon: HardDrive },
      { to: '/admin/reviews', label: 'Review queue', icon: ListChecks },
      { to: '/admin/organize', label: 'Organize', icon: FolderTree },
      { to: '/admin/search-index', label: 'Search index', icon: DatabaseZap },
      { to: '/admin/providers', label: 'Providers', icon: PlugZap },
    ],
  },
  {
    label: 'Server',
    sections: [
      { to: '/admin/users', label: 'Users & invites', icon: Users },
      { to: '/admin/settings', label: 'Server settings', icon: SlidersHorizontal },
      { to: '/admin/jobs', label: 'Jobs', icon: Briefcase },
    ],
  },
]

/** `counts` puts a small number beside a section, keyed by its path: open reviews, say. `version` is the server's. */
export function AdminLayout({ counts, version }: { counts?: Record<string, number | undefined>; version?: string }) {
  return (
    <Page className="flex flex-col gap-6">
      <PageTitle>Admin</PageTitle>
      <div className="flex flex-col gap-8 lg:flex-row">
        <div className="shrink-0 lg:w-52">
          <nav aria-label="Admin sections" className="-mx-(--gutter) flex gap-1 overflow-x-auto px-(--gutter) [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-5 lg:px-0">
            {groups.map(group => (
              <div key={group.label} className="flex shrink-0 gap-1 lg:flex-col">
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-quiet max-lg:hidden">{group.label}</p>
                {group.sections.map(({ to, label, icon: Icon }) => (
                  <NavLink key={to} to={to} className="group flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:text-accent">
                    <Icon aria-hidden className="size-[18px]" />{label}
                    {counts?.[to] ? <span aria-label={`, ${counts[to]} open`} className="ml-auto min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-bold leading-5 tabular text-on-accent max-lg:ml-0.5">{counts[to] > 99 ? '99+' : counts[to]}</span> : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          {version && <p className="mt-6 px-3 text-xs text-quiet max-lg:hidden">Squirmy {version}</p>}
        </div>
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
      {/* Below the page on narrow screens, where the sections are one scrolling row. */}
      {version && <p className="text-xs text-quiet lg:hidden">Squirmy {version}</p>}
    </Page>
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
