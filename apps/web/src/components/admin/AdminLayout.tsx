import { Briefcase, FolderTree, HardDrive, ListChecks, PlugZap, SlidersHorizontal, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { Page } from '@/components/layout/Page'
import { PageTitle } from '@/components/music/SectionHeader'

const sections = [
  { to: '/admin/library', label: 'Library', icon: HardDrive },
  { to: '/admin/reviews', label: 'Review queue', icon: ListChecks },
  { to: '/admin/organize', label: 'Organize', icon: FolderTree },
  { to: '/admin/users', label: 'Users & invites', icon: Users },
  { to: '/admin/providers', label: 'Providers', icon: PlugZap },
  { to: '/admin/settings', label: 'Server settings', icon: SlidersHorizontal },
  { to: '/admin/jobs', label: 'Jobs', icon: Briefcase },
]

export function AdminLayout() {
  return (
    <Page className="flex flex-col gap-6">
      <PageTitle>Admin</PageTitle>
      <div className="flex flex-col gap-8 lg:flex-row">
        <nav aria-label="Admin sections" className="-mx-(--gutter) flex shrink-0 gap-1 overflow-x-auto px-(--gutter) [scrollbar-width:none] lg:mx-0 lg:w-52 lg:flex-col lg:px-0">
          {sections.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className="flex h-10 shrink-0 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:text-accent">
              <Icon aria-hidden className="size-[18px]" />{label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1"><Outlet /></div>
      </div>
    </Page>
  )
}

export function AdminHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-[-0.03em]">{title}</h2>
        {description && <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>}
      </div>
      {children && <div className="flex gap-2">{children}</div>}
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

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} className="h-1.5 overflow-hidden rounded-full bg-stroke">
      <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${value * 100}%` }} />
    </div>
  )
}
