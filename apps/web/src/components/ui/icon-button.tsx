import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip } from './tooltip'

const iconButtonVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center outline-none transition-[color,background-color,transform,opacity] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:text-primary',
        solid: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border bg-background text-foreground shadow-xs hover:bg-accent dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        /** Over artwork, whatever the theme. */
        glass: 'bg-black/35 text-white backdrop-blur-md hover:bg-black/50',
        primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-95',
        contrast: 'bg-foreground text-background hover:bg-foreground/90 active:scale-95',
      },
      size: {
        xs: 'size-6 [&_svg]:size-3.5',
        sm: 'size-8 [&_svg]:size-4',
        md: 'size-9 [&_svg]:size-[18px]',
        lg: 'size-10 [&_svg]:size-5',
        xl: 'size-12 [&_svg]:size-6',
      },
      shape: {
        square: 'rounded-lg',
        round: 'rounded-full',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md', shape: 'square' },
  },
)

export type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & VariantProps<typeof iconButtonVariants> & {
  /** Read by screen readers and shown as a tooltip. */
  label: string
  /** Hide the tooltip, for buttons whose purpose is obvious from nearby text. */
  tooltip?: boolean
  /** Toggle buttons: the on state is drawn in the theme's action color. */
  pressed?: boolean
}

export function IconButton({ label, tooltip = true, pressed, variant, size, shape, className, children, type = 'button', ...props }: IconButtonProps) {
  return (
    <Tooltip label={tooltip ? label : null}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(iconButtonVariants({ variant, size, shape }), className)}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  )
}
