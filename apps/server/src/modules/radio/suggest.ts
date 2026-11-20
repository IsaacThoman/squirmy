import type { QueueSeed } from '@squirmy/contracts'
import { suggest } from './ranking.js'

/**
 * Seam between sessions and radio: tracks to play after the queue runs out.
 * Returns playable tracks only, none of them in `exclude`.
 *
 * This is also how a radio continues: its tracks become the session history, so once
 * they run out the next batch is seeded from the radio's own last tracks.
 */
export async function suggestAutoplay(request: {
  userId: string
  /** Recently played recordings, most recent last. */
  seeds: readonly string[]
  exclude: readonly string[]
  limit: number
}): Promise<QueueSeed[]> {
  return suggest(request)
}
