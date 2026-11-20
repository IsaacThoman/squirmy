import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-surface', className)} {...props} />
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <svg role="status" aria-label={label} viewBox="0 0 24 24" fill="none" className={cn('size-5 animate-spin text-accent', className)}>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

const badgeTones = {
  neutral: 'bg-surface text-muted',
  accent: 'bg-selection text-accent',
  outline: 'border border-stroke text-muted',
  danger: 'bg-danger/12 text-danger',
} as const

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof badgeTones }) {
  return <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-bold uppercase tracking-wide [&_svg]:size-3', badgeTones[tone], className)} {...props} />
}

/** The small "E" beside explicit tracks. */
export function ExplicitBadge({ className }: { className?: string }) {
  return (
    <abbr title="Explicit" className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-quiet/25 text-[9px] font-bold text-muted no-underline', className)}>
      E
    </abbr>
  )
}

export function EmptyState({ icon, title, description, action, className }: { icon: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-selection text-accent [&_svg]:size-6">{icon}</div>
      <h3 className="text-[19px] font-bold tracking-tight">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
