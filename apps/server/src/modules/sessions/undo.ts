import { reduceSession, type Session } from '@squirmy/client-core'
import { QUEUE_LIMIT, type QueueEntry, type SessionCommand, UNDO_KEEP_MS, UNDO_LIMIT } from '@squirmy/contracts'

/**
 * What undoing one queue edit needs, kept from the sessions before and after it (see "Undo"
 * in the session contract). Entries are named by id, so edits made since, from any device,
 * leave it meaningful.
 */
export type UndoStep = { commandId: string; at: number } & (
  /** `after`: the id of the entry before it in `list` (null: it was first), and in `playOrder` while shuffled. */
  | { type: 'removeFromQueue'; list: 'queue' | 'autoplayQueue'; entry: QueueEntry; after: string | null; orderAfter: string | null | undefined }
  | { type: 'enqueue'; ids: string[] }
  | { type: 'moveInQueue'; list: 'queue' | 'autoplayQueue'; entryId: string; after: string | null }
  | { type: 'clearQueue'; entries: QueueEntry[]; playOrder: string[] }
)

/** The step that undoes `command`, which turned `before` into `after`; null for a command that cannot be undone. */
export function undoStepFor(command: SessionCommand, commandId: string, before: Session, after: Session, at: number): UndoStep | null {
  switch (command.type) {
    case 'removeFromQueue': {
      for (const list of ['queue', 'autoplayQueue'] as const) {
        const index = before[list].findIndex(entry => entry.id === command.entryId)
        if (index < 0) continue
        const order = before.playOrder.indexOf(command.entryId)
        const orderAfter = order < 0 ? undefined : before.playOrder[order - 1] ?? null
        return { type: 'removeFromQueue', commandId, at, list, entry: before[list][index]!, after: before[list][index - 1]?.id ?? null, orderAfter }
      }
      return null
    }
    case 'enqueue': {
      const had = new Set(before.queue.map(entry => entry.id))
      const ids = after.queue.filter(entry => !had.has(entry.id)).map(entry => entry.id)
      return ids.length ? { type: 'enqueue', commandId, at, ids } : null
    }
    case 'moveInQueue': {
      for (const list of ['queue', 'autoplayQueue'] as const) {
        const index = before[list].findIndex(entry => entry.id === command.entryId)
        if (index >= 0) return { type: 'moveInQueue', commandId, at, list, entryId: command.entryId, after: before[list][index - 1]?.id ?? null }
      }
      return null
    }
    case 'clearQueue':
      return before.queue.length ? { type: 'clearQueue', commandId, at, entries: before.queue, playOrder: before.playOrder } : null
    default:
      return null
  }
}

/** Keeps `step` on `stack`: the newest last, at most `UNDO_LIMIT`, none older than `UNDO_KEEP_MS`. */
export function pushUndo(stack: readonly UndoStep[], step: UndoStep): UndoStep[] {
  return [...fresh(stack, step.at), step].slice(-UNDO_LIMIT)
}

/** The steps still kept at `now`. */
export function fresh(stack: readonly UndoStep[], now: number): UndoStep[] {
  return stack.filter(step => now - step.at < UNDO_KEEP_MS)
}

/**
 * The session with `step` undone, or an error code: `nothing_to_undo` when nothing of it is
 * left to undo (the entries it removed are back, those it added are gone), `queue_full` when
 * putting entries back would grow the queue past `QUEUE_LIMIT`. `now` and `commandId` are
 * for the reducer, which a move back goes through so shuffle keeps its rules.
 */
export function applyUndo(session: Session, step: UndoStep, now: number, commandId: string): Session | 'nothing_to_undo' | 'queue_full' {
  switch (step.type) {
    case 'removeFromQueue': {
      if (holds(session, step.entry.id)) return 'nothing_to_undo'
      const list = session[step.list]
      if (step.list === 'queue' && list.length >= QUEUE_LIMIT) return 'queue_full'
      const playOrder = session.shuffle && step.orderAfter !== undefined ? insertAfter(session.playOrder, step.orderAfter, step.entry.id, id => id) : session.playOrder
      return { ...session, [step.list]: insertAfter(list, step.after, step.entry, entry => entry.id), playOrder }
    }
    case 'enqueue': {
      const ids = new Set(step.ids)
      const queue = session.queue.filter(entry => !ids.has(entry.id))
      if (queue.length === session.queue.length) return 'nothing_to_undo'
      return { ...session, queue, playOrder: session.playOrder.filter(id => !ids.has(id)) }
    }
    case 'moveInQueue': {
      const list = session[step.list]
      const from = list.findIndex(entry => entry.id === step.entryId)
      if (from < 0) return 'nothing_to_undo'
      const anchor = step.after === null ? -1 : list.findIndex(entry => entry.id === step.after)
      // Its index once it has moved: right after the anchor, which shifts down when the entry came before it.
      const toIndex = anchor < 0 ? 0 : anchor < from ? anchor + 1 : anchor
      if (toIndex === from) return 'nothing_to_undo'
      const next = reduceSession(session, { command: { type: 'moveInQueue', entryId: step.entryId, toIndex }, now, commandId })
      return next === session ? 'nothing_to_undo' : next
    }
    case 'clearQueue': {
      const entries = step.entries.filter(entry => !holds(session, entry.id))
      if (!entries.length) return 'nothing_to_undo'
      if (session.queue.length + entries.length > QUEUE_LIMIT) return 'queue_full'
      const back = new Set(step.playOrder)
      const playOrder = session.shuffle ? [...step.playOrder, ...session.playOrder.filter(id => !back.has(id))] : session.playOrder
      return { ...session, queue: [...entries, ...session.queue], playOrder }
    }
  }
}

/** Whether the session holds an entry with this id anywhere. */
function holds(session: Session, id: string): boolean {
  return session.current?.id === id
    || [session.queue, session.autoplayQueue, session.history, session.playedInCycle].some(list => list.some(entry => entry.id === id))
}

/** `list` with `item` right after the item keyed `after`; at the front when that is null or gone. */
function insertAfter<T>(list: readonly T[], after: string | null, item: T, key: (item: T) => string): T[] {
  const index = after === null ? -1 : list.findIndex(other => key(other) === after)
  return [...list.slice(0, index + 1), item, ...list.slice(index + 1)]
}
