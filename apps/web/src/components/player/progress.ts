/** Where progress bars draw the playback position: held between steps too small to see. */

/**
 * Steps a progress bar moves in: a 3000th of the track is under a device pixel on the widest bar
 * (Now Playing's, 768 px at 2x), so finer steps draw the same.
 */
export const PROGRESS_STEPS = 3000

/** The position a progress bar without clocks draws: held between steps too small to see. */
export function progressPosition(positionMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return positionMs
  const step = durationMs / PROGRESS_STEPS
  return Math.floor(positionMs / step) * step
}

/**
 * The position the seek bar shows: `progressPosition`, but on time to the millisecond whenever
 * the elapsed or the remaining clock turns over. The bar renders a few times a second, not on
 * every frame, and looks and reads the same.
 */
export function seekBarPosition(positionMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return positionMs
  const elapsedTurn = Math.floor(positionMs / 1000) * 1000
  const leftTurn = durationMs - Math.ceil((durationMs - positionMs) / 1000) * 1000
  return Math.max(progressPosition(positionMs, durationMs), elapsedTurn, Math.min(leftTurn, positionMs))
}
