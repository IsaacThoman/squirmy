import type { QueueSeed } from '@squirmy/contracts'
import { resolveMerged } from '../catalog/redirects.js'
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
  // Queues and histories keep the ids they were given, and a merge since then leaves
  // them redirecting. Candidates are current rows, so compare current ids: otherwise the
  // track a queue entry became is suggested again, and a merged seed has no album.
  const resolved = await resolveMerged('recordings', [...request.seeds, ...request.exclude])
  const current = (ids: readonly string[]) => ids.map((id) => resolved.get(id) ?? id)
  return suggest({ ...request, seeds: current(request.seeds), exclude: current(request.exclude) })
}
