import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { isApple } from '@/lib/platform'
import { useSelection, type RowSelection, type Selection } from './selection'

/**
 * The selection whose list was used last: ⌘A and Escape pressed outside every list (focus on
 * the page) act on it, as they would in a desktop app's one list.
 */
let lastUsed: Selection | null = null

/** Keys the focused element uses itself: typing, menus, dialogs. A selection leaves them alone. */
const ownsKeys = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="menuitem"], [role="listbox"], [role="combobox"], [role="dialog"]:not([data-player-keys]), [role="alertdialog"]'
/** Presses there do not end a selection: its bar, the menus and dialogs that act on it, and what is dragged onto. */
const keepsSelection = '[data-selection-bar], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [role="alertdialog"], [data-drop-target]'

/** ⌘ on a Mac, Ctrl elsewhere: the key that adds a row to the selection and picks all. */
export const commandKey = (event: { metaKey: boolean; ctrlKey: boolean }) => (isApple ? event.metaKey : event.ctrlKey)

/** The row at `index` of `list`, by the index it carries; mounted when it is in or next to the view. */
function rowAt(list: HTMLElement | null, index: number): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`:scope > [data-row-index="${index}"]`) ?? null
}

/** Moves focus to the row at `index`: its play button, else the first control in it. */
export function focusRow(list: HTMLElement | null, index: number): boolean {
  const row = rowAt(list, index)
  const control = row?.querySelector<HTMLElement>('[data-slot="row-play"]') ?? row?.querySelector<HTMLElement>('a[href]:not([tabindex="-1"]), button:not([disabled])')
  if (!control) return false
  control.focus({ preventScroll: true })
  row!.scrollIntoView?.({ block: 'nearest' })
  return true
}

/**
 * Multi-select for one list of rows, by key:
 * - a click picks a row, ⌘/Ctrl-click adds or removes one, Shift-click picks a range;
 * - ↑/↓ move focus between rows and Shift+↑/↓ grow the range;
 * - ⌘/Ctrl+A picks every row (in the list with focus, else the one used last) and Escape lets go;
 * - a press elsewhere on the page lets go too.
 */
export function useListSelection(keys: readonly string[], list: RefObject<HTMLElement | null>): { rows: RowSelection; onListKeyDown: (event: ReactKeyboardEvent) => void } {
  const selection = useSelection(keys)
  const [handlers] = useState(() => ({
    selection,
    onRowClick: (index: number, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
      lastUsed = selection
      selection.click(index, { toggle: commandKey(event), range: event.shiftKey })
    },
    onRowKeyDown: (index: number, event: ReactKeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(ownsKeys)) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      event.preventDefault()
      lastUsed = selection
      if (event.shiftKey) {
        const to = selection.extend(index, step)
        if (to !== undefined) focusRow(list.current, to)
      } else {
        focusRow(list.current, index + step)
      }
    },
  }))

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest(ownsKeys))) return
    if (commandKey(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      lastUsed = selection
      selection.selectAll()
    } else if (event.key === 'Escape' && selection.size) {
      // Before anything around the list (the floating queue) takes Escape to close.
      event.preventDefault()
      selection.clear()
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (lastUsed !== selection || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(ownsKeys) || (target && list.current?.contains(target))) return
      // From the page itself, not from another region with lists of its own (the sidebar, the queue, the player).
      const onPage = !target || target === document.body || target.id === 'main-content'
      if (commandKey(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a' && onPage) {
        event.preventDefault()
        selection.selectAll()
      } else if (event.key === 'Escape' && selection.size) {
        selection.clear()
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!selection.size) return
      const target = event.target instanceof Element ? event.target : null
      if (!target || list.current?.contains(target) || target.closest(keepsSelection)) return
      selection.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
      if (lastUsed === selection) lastUsed = null
    }
  }, [selection, list])

  return { rows: handlers, onListKeyDown }
}
