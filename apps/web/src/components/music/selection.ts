import { createContext, type KeyboardEvent, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react'

/**
 * The rows picked in one list, by key (a playlist item's id, else the track's id), never by DOM
 * node: a virtual list unmounts the rows out of view, and a selection must outlive that. Kept
 * apart from React state so that a click renders only the rows whose mark changes, as
 * `NowPlayingStore` does for the playing row.
 */
export class Selection {
  private keys: readonly string[] = []
  private picked = new Set<string>()
  /** Where a Shift-click or Shift+arrow range starts. */
  private anchor: string | null = null
  /** The row a Shift+arrow range ends on now. */
  private head: string | null = null
  private readonly listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version
  has = (key: string): boolean => this.picked.has(key)
  get size(): number { return this.picked.size }

  /** The picked rows' indexes, in the list's order. */
  indexes(): number[] {
    return this.keys.flatMap((key, index) => (this.picked.has(key) ? [index] : []))
  }

  /** The list's rows now. Rows gone from it (removed, filtered out) leave the selection. */
  setKeys(keys: readonly string[]): void {
    this.keys = keys
    if (!this.picked.size) return
    const present = new Set(keys)
    const kept = [...this.picked].filter(key => present.has(key))
    if (kept.length === this.picked.size) return
    if (this.anchor && !present.has(this.anchor)) this.anchor = kept[0] ?? null
    if (this.head && !present.has(this.head)) this.head = this.anchor
    this.replace(kept)
  }

  /**
   * A click on row `index`: alone it picks that row, `toggle` (⌘ or Ctrl) adds or removes it, and
   * `range` (Shift) picks every row from the anchor to it, added to the rest with `toggle` too.
   */
  click(index: number, { toggle = false, range = false }: { toggle?: boolean; range?: boolean } = {}): void {
    const key = this.keys[index]
    if (key === undefined) return
    if (range && this.anchor !== null && this.keys.includes(this.anchor)) {
      const span = this.span(this.keys.indexOf(this.anchor), index)
      this.head = key
      return this.replace(toggle ? [...this.picked, ...span] : span)
    }
    this.anchor = key
    this.head = key
    if (!toggle) return this.replace([key])
    const next = new Set(this.picked)
    if (!next.delete(key)) next.add(key)
    this.replace([...next])
  }

  /**
   * Shift+↑/↓ from row `from`: the range from the anchor grows or shrinks to the row `step`
   * away, which is returned so focus can follow it. Undefined at either end of the list.
   */
  extend(from: number, step: 1 | -1): number | undefined {
    const to = from + step
    if (to < 0 || to >= this.keys.length) return undefined
    if (this.anchor === null || !this.picked.has(this.anchor)) {
      this.anchor = this.keys[from]
      this.head = this.anchor
    }
    this.head = this.keys[to]
    this.replace(this.span(this.keys.indexOf(this.anchor), to))
    return to
  }

  selectAll(): void {
    if (this.picked.size === this.keys.length) return
    this.anchor ??= this.keys[0] ?? null
    this.replace(this.keys)
  }

  clear(): void {
    this.anchor = null
    this.head = null
    if (this.picked.size) this.replace([])
  }

  private span(a: number, b: number): string[] {
    return this.keys.slice(Math.min(a, b), Math.max(a, b) + 1)
  }

  private replace(keys: Iterable<string>): void {
    const next = new Set(keys)
    if (next.size === this.picked.size && [...next].every(key => this.picked.has(key))) return
    this.picked = next
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * The selection of the list a row is in, and the row's handlers for it, which keep one identity
 * so memoized rows are not rendered again. None for rows rendered on their own.
 */
export type RowSelection = {
  selection: Selection
  onRowClick: (index: number, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  onRowKeyDown: (index: number, event: KeyboardEvent) => void
}

export const SelectionContext = createContext<RowSelection | null>(null)

/** Whether the row `key` is picked. The row re-renders only when that changes. */
export function useSelected(key: string | undefined): boolean {
  const selection = useContext(SelectionContext)?.selection
  return useSyncExternalStore(
    selection?.subscribe ?? noSubscribe,
    () => (selection && key !== undefined ? selection.has(key) : false),
  )
}

/** How many rows are picked, for the bar that acts on them. */
export function useSelectionSize(selection: Selection): number {
  return useSyncExternalStore(selection.subscribe, () => selection.size)
}

const noSubscribe = () => () => {}

/**
 * One selection for a list of `keys`, kept in step with them. It belongs to the page: arriving
 * on another one starts afresh.
 */
export function useSelection(keys: readonly string[]): Selection {
  const [selection] = useState(() => new Selection())
  // Before paint: a row that left the list must not stay counted for a frame.
  useLayoutEffect(() => selection.setKeys(keys), [selection, keys])
  return selection
}

/** Whether a key press or click is meant for a control inside a row (a link, a button, a field) rather than the row itself. */
export function onControl(target: EventTarget | null, row: Element): boolean {
  const control = target instanceof Element ? target.closest('a, button, input, textarea, select, [role="menuitem"], [role="slider"]') : null
  return control !== null && row.contains(control)
}
