import { Check, ChevronRight, CircleAlert } from 'lucide-react'
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive } from 'radix-ui'
import { createContext, use, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { errorMessage } from '@/api/errors'
import { cn } from '@/lib/utils'
import { Spinner } from './feedback'

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
  | MenuItem
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  /**
   * What the menu is for, whole: a song's title and artists, which its row cuts short. Shown where
   * the pointer is coarse, since a finger has no tooltip to read the rest in; it wraps instead.
   */
  | { kind: 'header'; label: string; detail?: string }
  | { kind: 'submenu'; label: string; icon?: ReactNode; items: MenuEntry[]; disabled?: boolean }

/**
 * An action. Most close the menu as they run. One whose result nothing else on screen shows
 * (Play next, Add to a playlist) says `done` in its own place for a moment, then the menu
 * closes. One that returns a promise keeps the menu open while it runs: it resolves to close
 * (saying `done`, if any; `false` closes at once, for an action that went on elsewhere, such
 * as a dialog), and a rejection says why on the item, which can be pressed again.
 */
export type MenuItem = {
  kind?: 'item'
  label: string
  icon?: ReactNode
  onSelect: () => void | Promise<unknown>
  /** What the item says once it worked, when nothing else shows it: "Added to queue". */
  done?: string
  disabled?: boolean
  danger?: boolean
  shortcut?: string
}

/** How long an item says it worked before its menu closes. */
export const MENU_DONE_MS = 900

type Feedback = { key: string; state: 'pending' | 'done' | 'failed'; text?: string }

type MenuFeedback = { feedback: Feedback | null; select: (key: string, entry: MenuItem, event: Event) => void }

const MenuFeedbackContext = createContext<MenuFeedback>({ feedback: null, select: () => {} })

/**
 * The open state of one menu, and what its items say as they run. Opening the menu again
 * starts afresh: a late answer to an action from before does nothing.
 */
function useMenuState(given: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const round = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const open = given.open ?? own
  const onOpenChange = (next: boolean) => {
    round.current += 1
    clearTimeout(timer.current)
    setFeedback(null)
    setOwn(next)
    given.onOpenChange?.(next)
  }
  const select = (key: string, entry: MenuItem, event: Event) => {
    // Pressed again while it runs or says it worked: once is enough.
    if (feedback?.key === key && feedback.state !== 'failed') return event.preventDefault()
    const result = entry.onSelect()
    if (!(result instanceof Promise) && !entry.done) return
    event.preventDefault()
    const at = round.current
    const done = () => {
      if (round.current !== at) return
      if (!entry.done) return onOpenChange(false)
      setFeedback({ key, state: 'done', text: entry.done })
      timer.current = setTimeout(() => { if (round.current === at) onOpenChange(false) }, MENU_DONE_MS)
    }
    if (!(result instanceof Promise)) return done()
    setFeedback({ key, state: 'pending' })
    result.then(
      value => (value === false ? round.current === at && onOpenChange(false) : done()),
      (error: unknown) => { if (round.current === at) setFeedback({ key, state: 'failed', text: errorMessage(error) }) },
    )
  }
  return { open, onOpenChange, feedback: { feedback, select } satisfies MenuFeedback }
}

/** What an item says once it worked or failed, read out: it is in the item, which may keep focus without its name being read again. */
function Announcement() {
  const { feedback } = use(MenuFeedbackContext)
  return <span role="status" className="sr-only">{feedback?.state === 'pending' ? '' : feedback?.text}</span>
}

type Parts = typeof DropdownPrimitive | typeof ContextPrimitive

/**
 * An item's words: one line, cut short when the menu is narrow. Names long enough to be cut (a
 * playlist's) carry their whole text as a tooltip; short ones would only get a tooltip in the way.
 */
function Label({ text }: { text: string }) {
  return <span title={text.length > 24 ? text : undefined} className="min-w-0 truncate">{text}</span>
}

function Entries({ parts, entries, path = '' }: { parts: Parts; entries: MenuEntry[]; path?: string }) {
  const { feedback, select } = use(MenuFeedbackContext)
  return entries.map((entry, index) => {
    const key = `${path}${index}`
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
              <Entries parts={parts} entries={entry.items} path={`${key}.`} />
            </parts.SubContent>
          </parts.Portal>
        </parts.Sub>
      )
    }
    const shown = feedback?.key === key ? feedback : null
    return (
      <parts.Item
        key={index}
        disabled={entry.disabled}
        onSelect={event => select(key, entry, event)}
        aria-busy={shown?.state === 'pending' || undefined}
        data-variant={entry.danger ? 'danger' : undefined}
        data-feedback={shown?.state}
        className={menuItemClass}
      >
        {shown?.state === 'pending' ? <Spinner label={null} className="size-4 shrink-0" />
          : shown?.state === 'done' ? <Check className="text-primary" />
            : shown?.state === 'failed' ? <CircleAlert className="text-destructive" />
              : entry.icon}
        {shown?.state === 'failed'
          ? <span className="flex min-w-0 flex-col"><Label text={entry.label} /><span className="text-xs text-destructive">{shown.text}</span></span>
          : <Label text={shown?.state === 'done' ? shown.text! : entry.label} />}
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

export function DropdownMenu({ trigger, entries, align = 'end', side, contentClassName, open: givenOpen, onOpenChange: givenChange, ...props }: DropdownMenuProps) {
  const { open, onOpenChange, feedback } = useMenuState({ open: givenOpen, onOpenChange: givenChange })
  return (
    <DropdownPrimitive.Root open={open} onOpenChange={onOpenChange} {...props}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} side={side} sideOffset={4} collisionPadding={8} className={cn(menuContentClass, fitsDropdown, contentClassName)}>
          <MenuFeedbackContext value={feedback}>
            <Entries parts={DropdownPrimitive} entries={entries} />
            <Announcement />
          </MenuFeedbackContext>
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  )
}

export function ContextMenu({ entries, children, onOpenChange: givenChange }: { entries: MenuEntry[]; children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  const { open, onOpenChange, feedback } = useMenuState({ onOpenChange: givenChange })
  return (
    <ContextPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <ContextPrimitive.Trigger asChild>{children}</ContextPrimitive.Trigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.Content collisionPadding={8} className={cn(menuContentClass, fitsContext)}>
          <MenuFeedbackContext value={feedback}>
            <Entries parts={ContextPrimitive} entries={entries} />
            <Announcement />
          </MenuFeedbackContext>
        </ContextPrimitive.Content>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Root>
  )
}
