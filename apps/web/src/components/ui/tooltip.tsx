import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'

export const TooltipProvider = TooltipPrimitive.Provider

type TooltipProps = {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Controls the tooltip from outside, as the folded sidebar does. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactElement
}

/** Wraps a single focusable element. Pass `label={null}` to render the child alone. */
export function Tooltip({ label, side = 'top', open, onOpenChange, children }: TooltipProps) {
  if (label === null || label === undefined) return children
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-fit max-w-64 animate-fade-in text-balance rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
