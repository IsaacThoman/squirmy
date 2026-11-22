import type { QueueEntry } from '@squirmy/contracts'

/** The parts of a session the failures are read from. */
export type SessionEntries = {
  current: QueueEntry | null
  queue: readonly QueueEntry[]
  autoplayQueue: readonly QueueEntry[]
  history: readonly QueueEntry[]
}

/** The entries whose failure is told: the one playing, and the one after it. */
export type Watched = { current: QueueEntry | null; next: QueueEntry | null }

export function watchedOf(session: SessionEntries): Watched {
  return { current: session.current, next: session.queue[0] ?? session.autoplayQueue[0] ?? null }
}

/** A song that could not be had. `held`: it is still current, failed, with playback stopped. */
export type FetchFailure = { entry: QueueEntry; held: boolean }

/**
 * The songs that could not be had between two looks at the session, among those that were
 * current or next: the ones a user is waiting for. A fetch further down the queue that fails
 * is quiet; its row turns gray, and the session skips it when it comes.
 *
 * - The current entry, still loading before, is gone now: the session skips a current entry
 *   that failed and keeps no trace of it (one skipped by hand or replaced goes to the history).
 * - The current entry is still current, failed (`held`): the queue had nothing after it, or the
 *   session paused after failures in a row, which it tells once itself (`playback.unavailable`).
 * - The next entry turned failed.
 */
export function failedFetches(before: Watched, after: SessionEntries): FetchFailure[] {
  const entries = [after.current, ...after.queue, ...after.autoplayQueue, ...after.history]
  const find = (id: string) => entries.find(entry => entry?.id === id)
  const failed: FetchFailure[] = []
  const { current, next } = before
  if (current?.state === 'preparing') {
    const now = find(current.id)
    if (!now) failed.push({ entry: current, held: false })
    else if (now.state === 'failed' && after.current?.id === now.id) failed.push({ entry: now, held: true })
  }
  if (next && next.state !== 'failed') {
    const now = find(next.id)
    if (now?.state === 'failed' && after.current?.id !== now.id) failed.push({ entry: now, held: false })
  }
  return failed
}
