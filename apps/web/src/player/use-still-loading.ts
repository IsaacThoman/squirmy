import type { QueueEntry } from '@squirmy/contracts'
import { useEffect, useState } from 'react'

/** How long the current track may load before its subtitle says so. Most fetches take 4 to 9 seconds. */
export const STILL_LOADING_MS = 8000

// When each entry was first seen loading, so a view opened later (Now Playing) counts from then too.
const since = new Map<string, number>()

/**
 * True once `entry` has been loading (`preparing`) for `STILL_LOADING_MS`: the player then
 * says "Still loading…" in place of the artist. Nothing else changes.
 */
export function useStillLoading(entry: Pick<QueueEntry, 'id' | 'state'> | null | undefined): boolean {
  const id = entry?.state === 'preparing' ? entry.id : null
  const [late, setLate] = useState<string | null>(null)
  useEffect(() => {
    if (!id) return
    const start = since.get(id) ?? Date.now()
    since.set(id, start)
    const timer = setTimeout(() => setLate(id), Math.max(0, start + STILL_LOADING_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [id])
  // An entry that loaded is not looked up again; keeping its time would only grow the map.
  useEffect(() => {
    if (entry && entry.state !== 'preparing') since.delete(entry.id)
  }, [entry])
  return id !== null && late === id
}

/** "Still loading…", the one word the player has for a fetch that takes long. */
export const STILL_LOADING_LABEL = 'Still loading…'
