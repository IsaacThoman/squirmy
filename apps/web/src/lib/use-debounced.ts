import { useEffect, useState } from 'react'

/** `value`, once it has stopped changing for `delayMs`; `initial` until then. */
export function useDebounced<T>(value: T, delayMs: number, initial: T): T {
  const [settled, setSettled] = useState(initial)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}
