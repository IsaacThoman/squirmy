import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** The filter pill from the iOS app: accent when selected, surface otherwise. */
export const pillClass = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface px-3.5 text-[13px] font-semibold text-foreground transition duration-150 hover:brightness-95 dark:hover:brightness-125 aria-[current=page]:bg-accent aria-[current=page]:text-on-accent data-[state=active]:bg-accent data-[state=active]:text-on-accent'

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex flex-wrap gap-2', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(pillClass, className)} {...props} />
}
