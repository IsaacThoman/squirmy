import type { FormEvent, ReactNode } from 'react'
import { matchPath, Outlet, useLocation } from 'react-router'
import type { FormErrors } from '@/api/errors'
import { Page } from '@/components/layout/Page'
import { SettingsNav } from '@/components/layout/Settings'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/input'

const sections = [
  { to: '/admin/library', label: 'Library' },
  { to: '/admin/reviews', label: 'Review queue' },
  { to: '/admin/organize', label: 'Organize' },
  { to: '/admin/search-index', label: 'Search index' },
  { to: '/admin/providers', label: 'Providers' },
  { to: '/admin/users', label: 'Users & invites' },
  { to: '/admin/jobs', label: 'Jobs' },
  { to: '/admin/settings', label: 'Server settings' },
]

/** `counts` puts a small number beside a section, keyed by its path: open reviews, say. `version` is the server's. */
export function AdminLayout({ counts, version }: { counts?: Record<string, number | undefined>; version?: string }) {
  const { pathname } = useLocation()
  const active = sections.find(({ to }) => matchPath(to, pathname))?.to ?? sections[0].to
  const links = sections.map(section => {
    const count = counts?.[section.to]
    return {
      ...section,
      badge: count ? <span aria-label={`, ${count} open`} className="rounded-md bg-selection px-1.5 text-xs font-semibold tabular text-accent">{count > 99 ? '99+' : count}</span> : undefined,
    }
  })
  return (
    <Page>
      <header className="-mx-(--gutter) border-b border-stroke px-(--gutter) pb-3">
        <div className="mx-auto flex max-w-6xl flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Management</h1>
            {version && <p className="text-xs tabular text-quiet">Squirmy {version}</p>}
          </div>
          <SettingsNav label="Management sections" items={links} active={active} />
        </div>
      </header>
      <div className="mx-auto max-w-6xl pt-7"><Outlet /></div>
    </Page>
  )
}

export function AdminHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  )
}

/** A number with a label, for the top of admin pages. */
export function Stat({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) {
  return (
    <div className="rounded-xl border border-stroke bg-sheet p-4">
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
