import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The edge is the input color, 3:1 off the surface; in dark mode a fifteenth of it fills the field. */
export const inputClass = 'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive md:text-sm dark:bg-input/15'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(inputClass, 'h-auto min-h-16 py-2 field-sizing-content', className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />
}

/** A labelled field with an optional hint or error below it. */
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {(error || hint) && <p id={`${htmlFor}-message`} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>{error ?? hint}</p>}
    </div>
  )
}

/** A failure of the whole form, such as a wrong password or a rate limit. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null
  return <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</p>
}
