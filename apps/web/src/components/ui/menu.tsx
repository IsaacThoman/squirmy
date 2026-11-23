import { ChevronRight } from 'lucide-react'
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const menuContentClass = 'z-50 min-w-44 max-w-[calc(100vw-1rem)] origin-(--radix-popper-transform-origin) animate-enter overflow-y-auto overflow-x-hidden overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=closed]:animate-exit'
/** A long menu (every playlist under "Add to playlist") scrolls within the room the screen has. */
const fitsDropdown = 'max-h-(--radix-dropdown-menu-content-available-height)'
const fitsContext = 'max-h-(--radix-context-menu-content-available-height)'
/**
 * A submenu opens beside its menu. On a phone neither side may have room for a long playlist
 * name, so it is never wider than the side it opens on (its names truncate), and never wider
 * than a comfortable column anywhere.
 */
const fitsDropdownSide = 'min-w-0 max-w-[min(18rem,var(--radix-dropdown-menu-content-available-width))]'
const fitsContextSide = 'min-w-0 max-w-[min(18rem,var(--radix-context-menu-content-available-width))]'
/** Items are 44 px tall for a finger (`pointer-coarse`), the touch target size the rest of the app uses. */
export const menuItemClass = "relative flex min-w-0 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm pointer-coarse:min-h-11 outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=danger]:text-destructive data-[variant=danger]:data-highlighted:bg-destructive/10 data-[variant=danger]:data-highlighted:text-destructive data-[variant=danger]:[&_svg]:text-destructive!"

/**
 * One description of a menu, rendered as either a dropdown or a right-click menu, so a row's
 * overflow button and its context menu always offer the same things.
 */
export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; shortcut?: string }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  /**
   * What the menu is for, whole: a song's title and artists, which its row cuts short. Shown where
   * the pointer is coarse, since a finger has no tooltip to read the rest in; it wraps instead.
   */
  | { kind: 'header'; label: string; detail?: string }
  | { kind: 'submenu'; label: string; icon?: ReactNode; items: MenuEntry[]; disabled?: boolean }

type Parts = typeof DropdownPrimitive | typeof ContextPrimitive

/**
 * An item's words: one line, cut short when the menu is narrow. Names long enough to be cut (a
 * playlist's) carry their whole text as a tooltip; short ones would only get a tooltip in the way.
 */
function Label({ text }: { text: string }) {
  return <span title={text.length > 24 ? text : undefined} className="min-w-0 truncate">{text}</span>
}

function Entries({ parts, entries }: { parts: Parts; entries: MenuEntry[] }) {
  return entries.map((entry, index) => {
    if (entry.kind === 'separator') return <parts.Separator key={index} className="-mx-1 my-1 h-px bg-border" />
    if (entry.kind === 'header') {
      // As wide as the items make the menu, never wider (`w-0 min-w-full`): a long title wraps.
      return (
        <parts.Label key={index} className="-mx-1 mb-1 hidden w-0 min-w-[calc(100%+0.5rem)] border-b px-3 pb-2 pt-1.5 wrap-break-word pointer-coarse:block">
          <span className="block text-sm font-medium">{entry.label}</span>
          {entry.detail && <span className="block text-xs text-muted-foreground">{entry.detail}</span>}
        </parts.Label>
      )
    }
    if (entry.kind === 'label') return <parts.Label key={index} className="max-w-64 truncate px-2 py-1.5 text-xs font-medium text-muted-foreground">{entry.label}</parts.Label>
    if (entry.kind === 'submenu') {
      return (
        <parts.Sub key={index}>
          <parts.SubTrigger disabled={entry.disabled} className={cn(menuItemClass, 'cursor-default data-[state=open]:bg-accent data-[state=open]:text-accent-foreground')}>
            {entry.icon}<Label text={entry.label} /><ChevronRight className="ml-auto" />
          </parts.SubTrigger>
          <parts.Portal>
            <parts.SubContent sideOffset={4} collisionPadding={8} className={cn(menuContentClass, parts === DropdownPrimitive ? [fitsDropdown, fitsDropdownSide] : [fitsContext, fitsContextSide], 'shadow-lg')}>
              <Entries parts={parts} entries={entry.items} />
            </parts.SubContent>
          </parts.Portal>
        </parts.Sub>
      )
    }
    return (
      <parts.Item key={index} disabled={entry.disabled} onSelect={entry.onSelect} data-variant={entry.danger ? 'danger' : undefined} className={menuItemClass}>
        {entry.icon}<Label text={entry.label} />
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
        <DropdownPrimitive.Content align={align} side={side} sideOffset={4} collisionPadding={8} className={cn(menuContentClass, fitsDropdown, contentClassName)}>
          <Entries parts={DropdownPrimitive} entries={entries} />
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  )
}

export function ContextMenu({ entries, children, onOpenChange }: { entries: MenuEntry[]; children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  return (
    <ContextPrimitive.Root onOpenChange={onOpenChange}>
      <ContextPrimitive.Trigger asChild>{children}</ContextPrimitive.Trigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.Content collisionPadding={8} className={cn(menuContentClass, fitsContext)}>
          <Entries parts={ContextPrimitive} entries={entries} />
        </ContextPrimitive.Content>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Root>
  )
}
