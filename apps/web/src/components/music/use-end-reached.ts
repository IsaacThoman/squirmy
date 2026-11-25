import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Calls `onEndReached` when the last rendered item of a virtual list comes within a few of the
 * end, and again each time more items arrive while it is there. A new `onEndReached` alone does
 * not call it: lists pass a new one as their query's state changes, and a page that failed would
 * otherwise be asked for again on every render, without end.
 */
export function useEndReached(lastRendered: number, count: number, onEndReached: (() => void) | undefined, margin = 10) {
  const near = count > 0 && lastRendered >= count - margin
  const latest = useRef(onEndReached)
  useLayoutEffect(() => { latest.current = onEndReached })
  useEffect(() => {
    if (near) latest.current?.()
  }, [near, count])
}
