import { useRef, type WheelEvent } from 'react'

const wheelThreshold = 32
const gestureGapMs = 160

/** A deliberate vertical sweep, with small trackpad deltas counted as one gesture. */
export function useNowPlayingWheel(slide: 'up' | 'down', onGesture: () => void) {
  const gesture = useRef({ last: -Infinity, distance: 0 })
  return (event: WheelEvent<HTMLElement>) => {
    const { currentTarget, target, timeStamp, deltaX, deltaY, deltaMode } = event
    // React also bubbles events from portaled popovers. Leave those, lyrics and queue to scroll.
    if (!(target instanceof Element) || !currentTarget.contains(target) || target.closest('[data-now-playing-scroll]')) return
    // Use the browser's scroll direction so the sheet moves like scrolled content:
    // a positive delta scrolls down and moves content up.
    const distance = slide === 'up' ? deltaY : -deltaY
    if (event.ctrlKey || event.shiftKey || distance <= Math.abs(deltaX)) {
      gesture.current.distance = 0
      return
    }
    const state = gesture.current
    if (timeStamp - state.last > gestureGapMs) state.distance = 0
    state.last = timeStamp
    state.distance += distance * (deltaMode === 1 ? 16 : deltaMode === 2 ? currentTarget.clientHeight : 1)
    if (state.distance < wheelThreshold) return
    state.distance = 0
    onGesture()
  }
}
