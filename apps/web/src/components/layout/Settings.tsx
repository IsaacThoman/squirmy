import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A titled group of settings rows on a surface card. */
export function SettingsSection({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-end justify-between gap-4 px-1">
        <div>
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="divide-y divide-stroke overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">{children}</div>
    </section>
  )
}

export function SettingRow({ label, description, htmlFor, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {htmlFor ? <label htmlFor={htmlFor} className="text-[15px] font-semibold">{label}</label> : <div className="text-[15px] font-semibold">{label}</div>}
        {description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}
