import type { QueueEntry, QueueLengths, QueueListName, QueueOp, QueueOpItem, SessionQueue } from '@squirmy/contracts'

/**
 * Past any of these a queue change goes out whole (`session:queue`) rather than as
 * operations: the operations would cost about as much as the queue, or more to apply.
 * `inline`: entries written out in full. `permute`: the longest reordering. `bytes`: the
 * operations' JSON.
 */
export const QUEUE_OPS_LIMITS = { inline: 256, permute: 2000, bytes: 64 * 1024 }
export type QueueOpsLimits = typeof QUEUE_OPS_LIMITS

/** Lists in the order `diffQueue` writes them, so a ref can name an entry an earlier list inlined. */
const LISTS = ['queue', 'history', 'autoplayQueue', 'playedInCycle', 'playOrder'] as const satisfies readonly QueueListName[]
const ENTRY_LISTS = ['queue', 'history', 'autoplayQueue', 'playedInCycle'] as const

type Item = QueueEntry | string

/** The lengths `session:queueOps` carries for checking. */
export function queueLengths(queue: SessionQueue): QueueLengths {
  return {
    queue: queue.queue.length,
    history: queue.history.length,
    autoplayQueue: queue.autoplayQueue.length,
    playOrder: queue.playOrder.length,
    playedInCycle: queue.playedInCycle.length,
  }
}

/**
 * The entries a ref may name: those inlined by the operations applied so far (the latest
 * wins), then those of the base queue, the first of each id in `ENTRY_LISTS` order. The
 * server and the client build it from the same base in the same order, so a ref means the
 * same entry at both ends.
 */
class Entries {
  private readonly inlined = new Map<string, QueueEntry>()
  private base: Map<string, QueueEntry> | null = null

  constructor(private readonly queue: SessionQueue) {}

  get(id: string): QueueEntry | undefined {
    return this.inlined.get(id) ?? this.baseEntries().get(id)
  }

  inline(entry: QueueEntry): void {
    this.inlined.set(entry.id, entry)
  }

  /** Built on the first ref only: most changes need none. */
  private baseEntries(): Map<string, QueueEntry> {
    if (this.base) return this.base
    const base = new Map<string, QueueEntry>()
    for (const list of ENTRY_LISTS) for (const entry of this.queue[list]) if (!base.has(entry.id)) base.set(entry.id, entry)
    return this.base = base
  }
}

/**
 * Applies `session:queueOps` operations to `base`. Lists no operation names keep their
 * identity. Null when they do not apply: an index past the end, an unknown ref, an item of
 * the wrong kind for its list, a patch that changes an entry's id, or (when `lengths` is
 * given) lengths that differ afterwards. The caller then asks for the whole queue.
 */
export function applyQueueOps(base: SessionQueue, ops: readonly QueueOp[], lengths?: QueueLengths): SessionQueue | null {
  const entries = new Entries(base)
  const lists: Partial<Record<QueueListName, Item[]>> = {}
  for (const op of ops) {
    const items = lists[op.list] ?? base[op.list]
    const applied = applyOp(op, items, entries)
    if (!applied) return null
    lists[op.list] = applied
  }
  const result = { ...base, ...lists } as SessionQueue
  if (lengths && LISTS.some(list => result[list].length !== lengths[list])) return null
  return result
}

/** One operation on one list. Never changes `items`. */
function applyOp(op: QueueOp, items: readonly Item[], entries: Entries): Item[] | null {
  switch (op.op) {
    case 'splice': {
      if (op.at + op.remove > items.length) return null
      const inserted: Item[] = []
      for (const item of op.insert) {
        const resolved = resolve(op.list, item, entries)
        if (resolved === undefined) return null
        inserted.push(resolved)
      }
      return [...items.slice(0, op.at), ...inserted, ...items.slice(op.at + op.remove)]
    }
    case 'removeIds': {
      const ids = new Set(op.ids)
      return items.filter(item => !ids.has(keyOf(item)))
    }
    case 'permute': {
      const { at, from } = op
      if (at + from.length > items.length) return null
      const seen = new Uint8Array(from.length)
      for (const index of from) {
        if (index >= from.length || seen[index]) return null
        seen[index] = 1
      }
      const result = [...items]
      for (let i = 0; i < from.length; i += 1) result[at + i] = items[at + from[i]!]!
      return result
    }
    case 'patch': {
      const current = items[op.at]
      if (op.list === 'playOrder' || current === undefined) return null
      const entry = resolve(op.list, op.entry, entries)
      if (entry === undefined || keyOf(entry) !== keyOf(current)) return null
      const result = [...items]
      result[op.at] = entry
      return result
    }
  }
}

function resolve(list: QueueListName, item: QueueOpItem, entries: Entries): Item | undefined {
  if (list === 'playOrder') return typeof item === 'string' ? item : undefined
  if (typeof item === 'string') return undefined
  if ('ref' in item) return entries.get(item.ref)
  entries.inline(item)
  return item
}

/**
 * The operations that turn `previous` into `next`, or null when they would pass `limits`
 * (send the whole queue then). Only lists whose identity changed are compared, so the
 * reducer's unchanged lists cost nothing. Each changed list is trimmed of what it shares at
 * both ends, and what is left becomes one of: an insertion, a removal, one entry moved, a
 * shift (entries dropped from the front and others appended, as `history` and
 * `playedInCycle` do at their caps), a reordering, a removal of scattered ids, or else one
 * splice; then entries whose state or track changed are patched. Diffing the result rather
 * than replaying commands covers every way a session changes.
 */
export function diffQueue(previous: SessionQueue, next: SessionQueue, limits: QueueOpsLimits = QUEUE_OPS_LIMITS): QueueOp[] | null {
  const entries = new Entries(previous)
  const ops: QueueOp[] = []
  let inlined = 0
  for (const list of LISTS) {
    const before: readonly Item[] = previous[list]
    const after: readonly Item[] = next[list]
    if (before === after) continue
    // Applied as they are made, with the same resolver the client uses, so what a ref
    // names and what still needs a patch are what the client will see.
    let items: readonly Item[] = before
    const push = (op: QueueOp) => {
      items = applyOp(op, items, entries)!
      ops.push(op)
      if (op.op === 'splice') inlined += op.insert.filter(item => typeof item !== 'string' && !('ref' in item)).length
      if (op.op === 'patch' && !('ref' in op.entry)) inlined += 1
    }
    for (const op of reshape(list, before, after, entries)) {
      if (op.op === 'permute' && op.from.length > limits.permute) return null
      push(op)
    }
    if (list !== 'playOrder') {
      for (let at = 0; at < after.length; at += 1) {
        const want = after[at] as QueueEntry
        const have = items[at] as QueueEntry
        if (have !== want && !sameEntry(have, want)) push({ op: 'patch', list, at, entry: itemOf(want, entries) as QueueEntry | { ref: string } })
      }
    }
    if (inlined > limits.inline) return null
  }
  return JSON.stringify(ops).length > limits.bytes ? null : ops
}

/** Operations that give `before` the ids of `after`, in order. Entries are written as refs where the client holds an equal one. */
function reshape(list: QueueListName, before: readonly Item[], after: readonly Item[], entries: Entries): QueueOp[] {
  const items = (from: readonly Item[]) => from.map(item => itemOf(item, entries))
  const splice = (at: number, remove: number, insert: readonly Item[] = []): QueueOp => ({ op: 'splice', list, at, remove, insert: items(insert) })
  let start = 0
  while (start < before.length && start < after.length && keyOf(before[start]!) === keyOf(after[start]!)) start += 1
  let end = 0
  while (end < before.length - start && end < after.length - start
    && keyOf(before[before.length - 1 - end]!) === keyOf(after[after.length - 1 - end]!)) end += 1
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  if (!a.length && !b.length) return []
  if (!a.length) return [splice(start, 0, b)]
  if (!b.length) return [splice(start, a.length)]

  const same = (x: readonly Item[], xFrom: number, y: readonly Item[], yFrom: number, count: number) => {
    for (let i = 0; i < count; i += 1) if (keyOf(x[xFrom + i]!) !== keyOf(y[yFrom + i]!)) return false
    return true
  }
  const last = a.length - 1
  if (a.length === b.length && a.length > 1) {
    // One item moved: what was trimmed leaves it at one end of the rest.
    if (keyOf(a[0]!) === keyOf(b[last]!) && same(a, 1, b, 0, last)) return [splice(start, 1), splice(start + last, 0, [b[last]!])]
    if (keyOf(a[last]!) === keyOf(b[0]!) && same(a, 0, b, 1, last)) return [splice(start + last, 1), splice(start, 0, [b[0]!])]
  }
  // Some dropped from the front and others appended: a list at its cap.
  const shift = a.findIndex(item => keyOf(item) === keyOf(b[0]!))
  if (shift > 0 && a.length - shift <= b.length && same(a, shift, b, 0, a.length - shift)) {
    const kept = a.length - shift
    return [splice(start, shift), ...(kept < b.length ? [splice(start + kept, 0, b.slice(kept))] : [])]
  }
  if (a.length === b.length) {
    const from = permutation(a, b)
    if (from) return [{ op: 'permute', list, at: start, from }]
  }
  if (b.length < a.length) {
    const removed = removedIds(before, start, end, a, b)
    if (removed) return [{ op: 'removeIds', list, ids: removed }]
  }
  return [splice(start, a.length, b)]
}

/** Where each item of `b` is in `a`, when `b` reorders `a`; null otherwise. */
function permutation(a: readonly Item[], b: readonly Item[]): number[] | null {
  const at = new Map<string, number[]>()
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const key = keyOf(a[i]!)
    const list = at.get(key)
    if (list) list.push(i)
    else at.set(key, [i])
  }
  const from: number[] = []
  for (const item of b) {
    const index = at.get(keyOf(item))?.pop()
    if (index === undefined) return null
    from.push(index)
  }
  return from
}

/**
 * The ids `removeIds` drops to turn the middle `a` into `b`, when `b` is `a` with items
 * left out and none of those ids is anywhere else in the list (it removes every match).
 */
function removedIds(before: readonly Item[], start: number, end: number, a: readonly Item[], b: readonly Item[]): string[] | null {
  const removed: string[] = []
  let j = 0
  for (const item of a) {
    if (j < b.length && keyOf(item) === keyOf(b[j]!)) j += 1
    else removed.push(keyOf(item))
  }
  if (j < b.length) return null
  const ids = new Set(removed)
  if (ids.size !== removed.length) return null
  for (const item of b) if (ids.has(keyOf(item))) return null
  for (let i = 0; i < start; i += 1) if (ids.has(keyOf(before[i]!))) return null
  for (let i = before.length - end; i < before.length; i += 1) if (ids.has(keyOf(before[i]!))) return null
  return removed
}

/** An entry as an operation carries it: a ref when the client holds an equal entry under its id. */
function itemOf(item: Item, entries: Entries): QueueOpItem {
  if (typeof item === 'string') return item
  const held = entries.get(item.id)
  return held && (held === item || sameEntry(held, item)) ? { ref: item.id } : item
}

function keyOf(item: Item): string {
  return typeof item === 'string' ? item : item.id
}

/** Same fields with the same values; a field left out equals one that is undefined. */
function sameEntry(a: QueueEntry, b: QueueEntry): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof QueueEntry)[])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}
