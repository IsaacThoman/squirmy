import type { ReactNode } from 'react'
import { Outlet } from 'react-router'
import { HeaderLink, Page, PageHeader } from '@/components/layout/Page'

const sections = [
  { to: '/admin/library', label: 'Library' },
  { to: '/admin/reviews', label: 'Review queue' },
  { to: '/admin/organize', label: 'Organize' },
  { to: '/admin/search-index', label: 'Search index' },
  { to: '/admin/providers', label: 'Providers' },
  { to: '/admin/users', label: 'Users & invites' },
  { to: '/admin/settings', label: 'Server settings' },
  { to: '/admin/jobs', label: 'Jobs' },
]

/** `counts` puts a small number beside a section, keyed by its path: open reviews, say. `version` is the server's. */
export function AdminLayout({ counts, version }: { counts?: Record<string, number | undefined>; version?: string }) {
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Admin"
        navLabel="Admin sections"
        nav={sections.map(({ to, label }) => <HeaderLink key={to} to={to} count={counts?.[to]}>{label}</HeaderLink>)}
      />
      <Page className="max-w-6xl flex-1"><Outlet /></Page>
      {version && <p className="mx-auto w-full max-w-6xl px-(--gutter) pb-6 text-xs text-muted-foreground">Squirmy {version}</p>}
    </div>
  )
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
