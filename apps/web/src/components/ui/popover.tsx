import { Popover as PopoverPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={10}
        collisionPadding={12}
        className={cn('z-50 w-80 origin-(--radix-popper-transform-origin) animate-enter rounded-3xl bg-sheet p-2 text-foreground shadow-float focus:outline-none data-[state=closed]:animate-exit', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
