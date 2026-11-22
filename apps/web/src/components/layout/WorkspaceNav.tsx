import type { LucideIcon } from 'lucide-react'
import { NavLink } from 'react-router'

export type WorkspaceLink = { to: string; label: string; icon: LucideIcon; count?: number; end?: boolean }
type WorkspaceGroup = { label?: string; links: WorkspaceLink[] }

export function WorkspaceNav({ label, groups }: { label: string; groups: WorkspaceGroup[] }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-2 rounded-xl border border-stroke bg-sheet p-2">
      {groups.map(group => (
        <div key={group.label ?? label} role={group.label ? 'group' : undefined} aria-label={group.label} className="flex flex-wrap items-center gap-1">
          {group.label && <span aria-hidden className="min-w-[4.25rem] px-2 text-xs font-semibold text-quiet">{group.label}</span>}
          {group.links.map(({ to, label, icon: Icon, count, end }) => (
            <NavLink key={to} to={to} end={end} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-[13px] font-semibold text-muted transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:text-accent">
              <Icon aria-hidden className="size-4 shrink-0" />{label}
              {count ? <span aria-label={`, ${count} open`} className="rounded-full bg-selection px-1.5 text-[11px] leading-5 tabular">{count > 99 ? '99+' : count}</span> : null}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )
}
