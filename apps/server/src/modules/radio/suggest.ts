import type { QueueSeed } from '@squirmy/contracts'

/**
 * Seam between sessions and radio: tracks to play after the queue runs out.
 * Returns playable tracks only, none of them in `exclude`.
 */
export async function suggestAutoplay(_request: {
  userId: string
  /** Recently played recordings, most recent last. */
  seeds: readonly string[]
  exclude: readonly string[]
  limit: number
}): Promise<QueueSeed[]> {
  return []
}
