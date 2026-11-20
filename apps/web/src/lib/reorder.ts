/** Returns a copy of `items` with the element at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

/** Where a row dragged `offset` pixels from `start` lands in a list of `count` rows of `rowHeight`. */
export function dropIndex(start: number, offset: number, rowHeight: number, count: number): number {
  return Math.max(0, Math.min(count - 1, start + Math.round(offset / rowHeight)))
}
