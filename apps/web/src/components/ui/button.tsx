import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './feedback'

const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-[color,background-color,border-color,box-shadow,opacity] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Filled buttons hold their focus ring off by a gap: in some themes the ring is the fill's own color.
        primary: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/15 dark:hover:bg-input/25',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        danger: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 gap-1.5 px-3 has-[>svg]:px-2.5',
        md: 'h-9 px-4 has-[>svg]:px-3',
        lg: 'h-10 px-6 has-[>svg]:px-4',
      },
    },
    // A link is as tall and wide as its text whatever the size; compound classes come after the size's.
    compoundVariants: [{ variant: 'link', class: 'h-auto px-0 has-[>svg]:px-0 shadow-none' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean
  /** Waiting on the request it started: disabled, with a spinner before the label. */
  pending?: boolean
}

export function Button({ className, variant, size, asChild, pending, disabled, children, type = 'button', ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className)
  if (asChild) return <Slot.Root data-slot="button" className={classes} {...props}>{children}</Slot.Root>
  return (
    <button type={type} data-slot="button" disabled={disabled || pending} aria-busy={pending || undefined} className={classes} {...props}>
      {/* Wrapped, so the padding for a leading icon does not change while it shows; the button's aria-busy says it is working. */}
      {pending && <span className="contents"><Spinner label={null} className="size-[1.1em] text-current" /></span>}
      {children}
    </button>
  )
}
