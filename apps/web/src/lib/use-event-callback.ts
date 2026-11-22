import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A function that keeps one identity for the component's life and always runs the latest
 * `callback`. For handlers given to memoized children, which would otherwise render again
 * whenever the parent does. Not for calling during render.
 */
export function useEventCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => { latest.current = callback })
  return useCallback((...args: Args) => latest.current(...args), [])
}
