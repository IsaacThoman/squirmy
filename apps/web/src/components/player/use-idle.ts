import { useCallback, useEffect, useRef, useState } from 'react'

/** With nothing moved or pressed for this long while music plays, lean-back mode's controls and the pointer fade away, in ms. */
export const LEAN_BACK_IDLE_MS = 3500

/**
 * Whether the viewer has left the screen alone for `ms`: no pointer moved, no tap, no wheel, and
 * no key (call `wake` from a key handler). Never while `hold` (the music is paused), so the
 * controls stay to start it again.
 */
export function useIdle(ms: number, hold: boolean): [idle: boolean, wake: () => void] {
  const [idle, setIdle] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const wake = useCallback(() => {
    setIdle(false)
    window.clearTimeout(timer.current)
    if (!hold) timer.current = window.setTimeout(() => setIdle(true), ms)
  }, [hold, ms])
  useEffect(() => {
    // Playing again starts the countdown over.
    window.clearTimeout(timer.current)
    if (!hold) timer.current = window.setTimeout(() => setIdle(true), ms)
    const events = ['pointermove', 'pointerdown', 'wheel', 'touchstart'] as const
    for (const event of events) window.addEventListener(event, wake, { passive: true })
    return () => {
      window.clearTimeout(timer.current)
      for (const event of events) window.removeEventListener(event, wake)
    }
  }, [hold, ms, wake])
  return [idle && !hold, wake]
}
