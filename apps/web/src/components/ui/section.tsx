import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type SectionProps = {
  title: string
  description?: ReactNode
  /** A control beside the title, such as "Add". */
  action?: ReactNode
  /** Draws the title in the error color, for destructive settings. */
  danger?: boolean
  children: ReactNode
  className?: string
}

/** A titled card of rows, as on the admin pages. */
export function Section({ title, description, action, danger, children, className }: SectionProps) {
  return (
    <section className={cn('@container', className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className={cn('text-sm font-semibold', danger && 'text-destructive')}>{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className="mt-3 divide-y rounded-xl border bg-card px-4 [&>*]:py-3">{children}</div>
    </section>
  )
}

type RowProps = {
  label: ReactNode
  description?: ReactNode
  /** The id of the control the label names. */
  htmlFor?: string
  children?: ReactNode
  className?: string
}

/**
 * A setting: its label and description on the left, its control on the right. In a narrow
 * container the control moves below. Used inside a `Section` and in the settings dialog.
 */
export function Row({ label, description, htmlFor, children, className }: RowProps) {
  return (
    <div className={cn('flex min-w-0 flex-col items-stretch gap-2 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6', className)}>
      <div className="min-w-0 flex-1 wrap-anywhere">
        {htmlFor ? <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label> : <div className="text-sm font-medium">{label}</div>}
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {children && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2 self-start @xl:self-auto">{children}</div>}
    </div>
  )
}
