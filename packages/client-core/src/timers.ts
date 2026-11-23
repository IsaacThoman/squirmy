// The package compiles without DOM or Node types, and every runtime it targets has these.
// Looking them up on each call keeps test fake timers working.

type Handle = unknown
type Timers = {
  setTimeout(callback: () => void, ms: number): Handle
  setInterval(callback: () => void, ms: number): Handle
  clearInterval(handle: Handle): void
  clearTimeout(handle: Handle): void
}

const timers = () => globalThis as unknown as Timers

export const setTimer = (callback: () => void, ms: number): Handle => timers().setTimeout(callback, ms)
export const setRepeating = (callback: () => void, ms: number): Handle => timers().setInterval(callback, ms)
export const clearRepeating = (handle: Handle): void => timers().clearInterval(handle)
export const clearTimer = (handle: Handle): void => timers().clearTimeout(handle)
