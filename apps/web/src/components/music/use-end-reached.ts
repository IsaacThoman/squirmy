import { useEffect } from 'react'

/** Calls `onEndReached` when the last rendered item of a virtual list is within a few of the end. */
export function useEndReached(lastRendered: number, count: number, onEndReached: (() => void) | undefined, margin = 10) {
  const near = count > 0 && lastRendered >= count - margin
  useEffect(() => {
    if (near) onEndReached?.()
  }, [near, count, onEndReached])
}
