/**
 * A track time as `m:ss`, e.g. `3:07`. Minutes are not wrapped into hours (`75:00`).
 * Negative and non-finite input counts as 0; partial seconds are dropped.
 */
export function formatDuration(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Time left, as shown at the right of a scrubber: `−1:23` (with a Unicode minus sign).
 * Rounded up to the second, so it reaches `−0:00` only at the very end (rounded down, the
 * last second of every track would read `−0:00`), and elapsed plus remaining always make
 * the whole length.
 */
export function formatRemaining(positionMs: number, durationMs: number): string {
  const left = Math.max(0, durationMs - positionMs)
  return `−${formatDuration(Math.ceil(left / 1000) * 1000)}`
}

/**
 * A total length for album and playlist headers, rounded to whole minutes and at least
 * one: `42 min`, `1 hr 5 min`, `2 hr`.
 */
export function formatTotalDuration(ms: number): string {
  const minutes = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 60000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}
