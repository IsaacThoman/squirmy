import type { QueueEntry } from '@squirmy/contracts'
import { useEffect, useState } from 'react'

/** How long the current track may load before its subtitle says so. Most fetches take 4 to 9 seconds. */
export const STILL_LOADING_MS = 8000

// When each entry was first seen waiting, so a view opened later (Now Playing) counts from then too.
const since = new Map<string, number>()

/**
 * True once `entry` has been waiting for its music (`PlayerState.waiting`: fetched, loading,
 * buffering, or offline) for `STILL_LOADING_MS`: the player then says "Still loading…" in
 * place of the artist. Nothing else changes.
 */
export function useStillLoading(entry: Pick<QueueEntry, 'id'> | null | undefined, waiting: boolean): boolean {
  const id = waiting && entry ? entry.id : null
  // Keyed by when the wait began, so a song that waits again later says so only after its own wait.
  const [late, setLate] = useState<{ id: string; start: number } | null>(null)
  useEffect(() => {
    if (!id) return
    const start = since.get(id) ?? Date.now()
    since.set(id, start)
    const timer = setTimeout(() => setLate({ id, start }), Math.max(0, start + STILL_LOADING_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [id])
  // Heard at last: a later stall counts afresh, and the map does not grow.
  const heard = entry && !waiting ? entry.id : null
  useEffect(() => {
    if (heard) since.delete(heard)
  }, [heard])
  return id !== null && late?.id === id && since.get(id) === late.start
}

/** "Still loading…", the one word the player has for a fetch that takes long. */
export const STILL_LOADING_LABEL = 'Still loading…'
