import { Briefcase, DatabaseZap, FolderTree, HardDrive, ListChecks, PlugZap, SlidersHorizontal, Users } from 'lucide-react'
import type { FormEvent, ReactNode } from 'react'
import { Outlet } from 'react-router'
import type { FormErrors } from '@/api/errors'
import { Page } from '@/components/layout/Page'
import { WorkspaceNav } from '@/components/layout/WorkspaceNav'
import { PageTitle } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/input'

const groups = [
  {
    label: 'Music',
    links: [
      { to: '/admin/library', label: 'Library', icon: HardDrive },
      { to: '/admin/reviews', label: 'Review queue', icon: ListChecks },
      { to: '/admin/organize', label: 'Organize', icon: FolderTree },
      { to: '/admin/search-index', label: 'Search index', icon: DatabaseZap },
      { to: '/admin/providers', label: 'Providers', icon: PlugZap },
    ],
  },
  {
    label: 'Server',
    links: [
      { to: '/admin/users', label: 'Users & invites', icon: Users },
      { to: '/admin/settings', label: 'Server settings', icon: SlidersHorizontal },
      { to: '/admin/jobs', label: 'Jobs', icon: Briefcase },
    ],
  },
]

/** `counts` puts a small number beside a section, keyed by its path: open reviews, say. `version` is the server's. */
export function AdminLayout({ counts, version }: { counts?: Record<string, number | undefined>; version?: string }) {
  return (
    <Page className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <PageTitle>Admin</PageTitle>
        {version && <p className="pb-1 text-xs text-quiet">Squirmy {version}</p>}
      </header>
      <WorkspaceNav
        label="Admin sections"
        groups={groups.map(group => ({
          ...group,
          links: group.links.map(link => ({ ...link, count: counts?.[link.to] })),
        }))}
      />
      <div className="min-w-0"><Outlet /></div>
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
