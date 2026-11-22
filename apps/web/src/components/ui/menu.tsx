import { ChevronRight } from 'lucide-react'
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const menuContentClass = 'z-50 min-w-44 max-w-[calc(100vw-1rem)] origin-(--radix-popper-transform-origin) animate-enter overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-exit'
export const menuItemClass = "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=danger]:text-destructive data-[variant=danger]:data-highlighted:bg-destructive/10 data-[variant=danger]:data-highlighted:text-destructive data-[variant=danger]:[&_svg]:text-destructive!"

/**
 * One description of a menu, rendered as either a dropdown or a right-click menu, so a row's
 * overflow button and its context menu always offer the same things.
 */
export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; shortcut?: string }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  | { kind: 'submenu'; label: string; icon?: ReactNode; items: MenuEntry[] }

type Parts = typeof DropdownPrimitive | typeof ContextPrimitive

function Entries({ parts, entries }: { parts: Parts; entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry.kind === 'separator') return <parts.Separator key={index} className="-mx-1 my-1 h-px bg-border" />
    if (entry.kind === 'label') return <parts.Label key={index} className="max-w-64 truncate px-2 py-1.5 text-xs font-medium text-muted-foreground">{entry.label}</parts.Label>
    if (entry.kind === 'submenu') {
      return (
        <parts.Sub key={index}>
          <parts.SubTrigger className={cn(menuItemClass, 'cursor-default data-[state=open]:bg-accent data-[state=open]:text-accent-foreground')}>
            {entry.icon}{entry.label}<ChevronRight className="ml-auto" />
          </parts.SubTrigger>
          <parts.Portal>
            <parts.SubContent sideOffset={4} className={cn(menuContentClass, 'shadow-lg')}><Entries parts={parts} entries={entry.items} /></parts.SubContent>
          </parts.Portal>
        </parts.Sub>
      )
    }
    return (
      <parts.Item key={index} disabled={entry.disabled} onSelect={entry.onSelect} data-variant={entry.danger ? 'danger' : undefined} className={menuItemClass}>
        {entry.icon}{entry.label}
        {entry.shortcut && <span aria-hidden className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground">{entry.shortcut}</span>}
      </parts.Item>
    )
  })
}

type DropdownMenuProps = {
  trigger: ReactNode
  entries: MenuEntry[]
  align?: 'start' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Extra classes for the menu, such as a width. */
  contentClassName?: string
} & ComponentProps<typeof DropdownPrimitive.Root>

export function DropdownMenu({ trigger, entries, align = 'end', side, contentClassName, ...props }: DropdownMenuProps) {
  return (
    <DropdownPrimitive.Root {...props}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} side={side} sideOffset={4} collisionPadding={8} className={cn(menuContentClass, contentClassName)}>
          <Entries parts={DropdownPrimitive} entries={entries} />
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  )
}

export function ContextMenu({ entries, children }: { entries: MenuEntry[]; children: ReactNode }) {
  return (
    <ContextPrimitive.Root>
      <ContextPrimitive.Trigger asChild>{children}</ContextPrimitive.Trigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.Content collisionPadding={8} className={menuContentClass}>
          <Entries parts={ContextPrimitive} entries={entries} />
        </ContextPrimitive.Content>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Root>
  )
}
