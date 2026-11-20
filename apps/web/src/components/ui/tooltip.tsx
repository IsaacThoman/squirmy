import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'

export const TooltipProvider = TooltipPrimitive.Provider

/** Wraps a single focusable element. Pass `label={null}` to render the child alone. */
export function Tooltip({ label, side = 'top', children }: { label: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactElement }) {
  if (label === null || label === undefined) return children
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-64 animate-fade-in rounded-lg bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background shadow-float"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
