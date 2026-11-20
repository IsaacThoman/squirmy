import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const inputClass = 'h-11 w-full min-w-0 rounded-xl border border-transparent bg-surface px-3.5 text-[15px] text-foreground transition duration-150 placeholder:text-quiet hover:border-stroke focus-visible:border-accent focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-selection disabled:opacity-50 aria-invalid:border-danger'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(inputClass, className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-[13px] font-semibold text-muted', className)} {...props} />
}

/** A labelled field with an optional hint or error below it. */
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {(error || hint) && <p className={cn('text-xs', error ? 'text-danger' : 'text-quiet')}>{error ?? hint}</p>}
    </div>
  )
}
