import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A row of sections: links marked `aria-current="page"` or tab triggers. The current one sits on
 * the hover color, like the sections of the admin panel and the settings dialog.
 */
export const pillClass = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground data-[state=active]:bg-accent data-[state=active]:font-medium data-[state=active]:text-foreground'

export const Tabs = TabsPrimitive.Root
export const TabsContent = TabsPrimitive.Content

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex flex-wrap gap-1', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn(pillClass, className)} {...props} />
}
