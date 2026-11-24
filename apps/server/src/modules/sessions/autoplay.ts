import type { QueueEntry } from '@squirmy/contracts'

/** Suggestions asked for at a time. */
export const AUTOPLAY_BATCH = 10
/** The tracks a batch is seeded from: those that play just before it. */
export const AUTOPLAY_SEEDS = 10
/**
 * Tracks kept out of a batch, counted back from where it starts. A queue holds up to 10,000
 * entries; the suggestions follow its end, and a long queue's start is hours behind them.
 */
export const AUTOPLAY_EXCLUDE = 500
/** Recently played tracks kept out of a batch too, so a queue's own start does not come back after it. */
export const AUTOPLAY_EXCLUDE_PLAYED = 100

type AutoplaySession = {
  autoplay: boolean
  current: QueueEntry | null
  queue: readonly QueueEntry[]
  history: readonly QueueEntry[]
  autoplayQueue: readonly QueueEntry[]
}

/**
 * What to ask the radio module for, or null when nothing should be asked. Asked as soon as
 * something plays with autoplay on and no suggestions, however long the queue is, so the
 * queue shows what comes after it from the start, as Apple Music's does. `playTracks`
 * empties the suggestions, so a new queue gets its own.
 *
 * Seeded from the tracks that play just before the suggestions: the end of the queue, or,
 * when the queue is short, what played before it too, most recent last.
 */
export function autoplayRequest(session: AutoplaySession): { seeds: string[]; exclude: string[] } | null {
  const { current } = session
  if (!session.autoplay || !current || session.autoplayQueue.length) return null
  const ahead = [...session.history, current, ...session.queue]
  const seeds = ahead.slice(-AUTOPLAY_SEEDS).map(entry => entry.trackId)
  const exclude = [...session.history.slice(-AUTOPLAY_EXCLUDE_PLAYED), current, ...session.queue.slice(-AUTOPLAY_EXCLUDE)]
    .map(entry => entry.trackId)
  return { seeds, exclude: [...new Set(exclude)] }
}
