import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip } from './tooltip'

const iconButtonVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center rounded-full transition duration-150 ease-out active:scale-[0.92] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        ghost: 'text-muted hover:bg-overlay hover:text-foreground aria-pressed:text-accent',
        solid: 'bg-surface text-foreground hover:brightness-95 dark:hover:brightness-125',
        glass: 'bg-black/30 text-white backdrop-blur-md hover:bg-black/45',
        accent: 'bg-accent text-on-accent shadow-cover hover:scale-[1.04] hover:brightness-110',
        contrast: 'bg-foreground text-background hover:scale-[1.05]',
      },
      size: {
        sm: 'size-8 [&_svg]:size-4',
        md: 'size-10 [&_svg]:size-5',
        lg: 'size-12 [&_svg]:size-6',
        xl: 'size-14 [&_svg]:size-7',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

export type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & VariantProps<typeof iconButtonVariants> & {
  /** Read by screen readers and shown as a tooltip. */
  label: string
  /** Hide the tooltip, for buttons whose purpose is obvious from nearby text. */
  tooltip?: boolean
  /** Toggle buttons: draws the on state with an accent dot. */
  pressed?: boolean
}

export function IconButton({ label, tooltip = true, pressed, variant, size, className, children, type = 'button', ...props }: IconButtonProps) {
  return (
    <Tooltip label={tooltip ? label : null}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
        {pressed && <span aria-hidden className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-accent" />}
      </button>
    </Tooltip>
  )
}
