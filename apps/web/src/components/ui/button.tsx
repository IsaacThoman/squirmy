import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Spinner } from './feedback'

const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:brightness-110',
        secondary: 'bg-surface text-foreground hover:bg-[color-mix(in_srgb,var(--surface),var(--foreground)_6%)]',
        outline: 'border border-stroke text-foreground hover:bg-overlay',
        ghost: 'text-foreground hover:bg-overlay',
        danger: 'bg-danger text-background hover:brightness-110',
        link: 'h-auto px-0 text-accent underline-offset-4 hover:underline active:scale-100',
      },
      size: {
        sm: 'h-8 px-3 text-[13px] [&_svg]:size-4',
        md: 'h-10 px-4 text-sm [&_svg]:size-[18px]',
        lg: 'h-12 px-5 text-[15px] [&_svg]:size-5',
      },
    },
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
  if (asChild) return <Slot.Root className={classes} {...props}>{children}</Slot.Root>
  return (
    <button type={type} disabled={disabled || pending} aria-busy={pending || undefined} className={classes} {...props}>
      {pending && <Spinner label="Working" className="size-[1.1em] text-current" />}
      {children}
    </button>
  )
}
