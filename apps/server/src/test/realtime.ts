import type { EntityChange } from '@squirmy/contracts'
import { getSql } from '../database/client.js'

/**
 * Collects what is published on the realtime channel from any process: `invalidate` keys,
 * `changes`, and the availability those changes carried by entity id (the latest wins).
 */
export async function listenRealtime() {
  const keys: unknown[][] = []
  const changes: EntityChange[] = []
  const availability = new Map<string, string>()
  const listener = await getSql().listen('squirmy_events', (payload) => {
    const message = JSON.parse(payload) as { kind: string; keys?: unknown[][]; changes?: EntityChange[] }
    if (message.kind === 'invalidate') keys.push(...message.keys!)
    if (message.kind !== 'changes') return
    changes.push(...message.changes!)
    for (const change of message.changes!) {
      if (change.kind !== 'availability') continue
      for (const entity of [...change.tracks, ...change.albums]) availability.set(entity.id, entity.availability)
    }
  })
  return { keys, changes, availability, stop: () => listener.unlisten() }
}
