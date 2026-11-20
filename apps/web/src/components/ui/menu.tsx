import { ChevronRight } from 'lucide-react'
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const menuContentClass = 'z-50 min-w-52 origin-(--radix-popper-transform-origin) animate-enter overflow-hidden rounded-2xl bg-sheet p-1.5 text-foreground shadow-float data-[state=closed]:animate-exit'
export const menuItemClass = 'relative flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium outline-none transition-colors duration-100 data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-overlay [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted data-[variant=danger]:text-danger'

/**
 * One description of a menu, rendered as either a dropdown or a right-click menu, so a row's
 * overflow button and its context menu always offer the same things.
 */
export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  | { kind: 'submenu'; label: string; icon?: ReactNode; items: MenuEntry[] }

type Parts = typeof DropdownPrimitive | typeof ContextPrimitive

function Entries({ parts, entries }: { parts: Parts; entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry.kind === 'separator') return <parts.Separator key={index} className="mx-1.5 my-1 h-px bg-stroke" />
    if (entry.kind === 'label') return <parts.Label key={index} className="max-w-64 px-2.5 pb-1 pt-1.5 text-xs font-semibold text-quiet">{entry.label}</parts.Label>
    if (entry.kind === 'submenu') {
      return (
        <parts.Sub key={index}>
          <parts.SubTrigger className={cn(menuItemClass, 'data-[state=open]:bg-overlay')}>
            {entry.icon}{entry.label}<ChevronRight className="ml-auto" />
          </parts.SubTrigger>
          <parts.Portal>
            <parts.SubContent sideOffset={6} className={menuContentClass}><Entries parts={parts} entries={entry.items} /></parts.SubContent>
          </parts.Portal>
        </parts.Sub>
      )
    }
    return (
      <parts.Item key={index} disabled={entry.disabled} onSelect={entry.onSelect} data-variant={entry.danger ? 'danger' : undefined} className={menuItemClass}>
        {entry.icon}{entry.label}
      </parts.Item>
    )
  })
}

export function DropdownMenu({ trigger, entries, align = 'end', ...props }: { trigger: ReactNode; entries: MenuEntry[]; align?: 'start' | 'end' } & ComponentProps<typeof DropdownPrimitive.Root>) {
  return (
    <DropdownPrimitive.Root {...props}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} sideOffset={6} collisionPadding={8} className={menuContentClass}>
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
