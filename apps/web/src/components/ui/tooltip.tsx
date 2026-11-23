import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { onCloseTooltips } from './tooltip-signal'

export const TooltipProvider = TooltipPrimitive.Provider

type TooltipProps = {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Controls the tooltip from outside, as the folded sidebar does. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** `error`: says what went wrong with the control, in the error color. */
  tone?: 'error'
  children: ReactElement
}

/** Wraps a single focusable element. Pass `label={null}` to render the child alone. */
export function Tooltip({ label, side = 'top', open, onOpenChange, tone, children }: TooltipProps) {
  // Held here rather than left to Radix, so `closeTooltips()` can close it from outside.
  const [shown, setShown] = useState(false)
  const latest = useRef(onOpenChange)
  useEffect(() => { latest.current = onOpenChange })
  useEffect(() => onCloseTooltips(() => {
    setShown(false)
    latest.current?.(false)
  }), [])
  if (label === null || label === undefined) return children
  return (
    <TooltipPrimitive.Root open={open ?? shown} onOpenChange={next => { setShown(next); onOpenChange?.(next) }}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          data-tone={tone}
          className={cn('z-50 w-fit max-w-64 animate-fade-in text-balance rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background', tone === 'error' && 'bg-destructive text-destructive-foreground')}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
