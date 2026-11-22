import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-accent', className)} {...props} />
}

/**
 * A turning ring. `label` names it for screen readers; null makes it decorative, for a control
 * that says it is busy itself. It keeps turning with reduced motion, slower: it is the only sign
 * that something is still happening.
 */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string | null }) {
  const name = label === null ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label }
  return (
    <svg {...name} viewBox="0 0 24 24" fill="none" className={cn('spinner size-5 text-muted-foreground', className)}>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

const badgeTones = {
  neutral: 'border-transparent bg-secondary text-secondary-foreground',
  // The action color mixed a little toward the text, so it reads at 4.5:1 on its own tint in every theme.
  accent: 'border-transparent bg-primary/10 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]',
  solid: 'border-transparent bg-primary text-primary-foreground',
  outline: 'text-muted-foreground',
  danger: 'border-transparent bg-destructive/10 text-destructive',
} as const

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof badgeTones }) {
  return <span className={cn('inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium [&_svg]:size-3', badgeTones[tone], className)} {...props} />
}

/** The small "E" beside explicit tracks. */
export function ExplicitBadge({ className }: { className?: string }) {
  return (
    <abbr title="Explicit" className={cn('inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-muted-foreground/25 text-[9px] font-semibold text-muted-foreground no-underline', className)}>
      E
    </abbr>
  )
}

export function EmptyState({ icon, title, description, action, className }: { icon: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs [&_svg]:size-5">{icon}</div>
      {/* Titles can echo what was typed: a long unbroken word wraps instead of widening the page. */}
      <h3 className="max-w-full text-base font-semibold [overflow-wrap:anywhere]">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/** `value` from 0 to 1, or null while the total is not known yet. */
export function ProgressBar({ value, label, className }: { value: number | null; label: string; className?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)} className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full bg-primary transition-[width] duration-200', value === null && 'animate-pulse opacity-50')} style={{ width: `${(value ?? 1) * 100}%` }} />
    </div>
  )
}

/** A key or key combination, as shown beside the action it triggers. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return <kbd className={cn('rounded border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground', className)} {...props} />
}

export function Separator({ className, orientation = 'horizontal' }: { className?: string; orientation?: 'horizontal' | 'vertical' }) {
  return <div role="none" className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)} />
}
