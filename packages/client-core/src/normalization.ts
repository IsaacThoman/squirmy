import type { Normalization, NormalizationMode } from '@squirmy/contracts'

export type GainContext = {
  /**
   * The entry is played as part of its album, in album order (the session's context is
   * that album and shuffle is off). Decides album versus track gain in `auto` mode.
   */
  albumContext: boolean
  /** The output can amplify above unity (Web Audio gain can; a plain volume cannot). */
  canBoost: boolean
}

/**
 * Linear gain multiplier for loudness normalization.
 *
 * - `off`, or no normalization data: 1.
 * - `track` uses the track gain, `album` the album gain; each falls back to the other
 *   when its own value is missing, and to 1 when both are.
 * - `auto` is `album` when `albumContext` and `track` otherwise.
 *
 * The result never exceeds `1 / peak` of the chosen value (so it cannot clip), and never
 * exceeds 1 when `canBoost` is false.
 */
export function gainFor(mode: NormalizationMode, normalization: Normalization | null | undefined, context: GainContext): number {
  if (mode === 'off' || !normalization) return 1
  const album = mode === 'album' || (mode === 'auto' && context.albumContext)
  const track = { gainDb: normalization.trackGainDb, peak: normalization.trackPeak }
  const whole = { gainDb: normalization.albumGainDb, peak: normalization.albumPeak }
  const [preferred, fallback] = album ? [whole, track] : [track, whole]
  const chosen = preferred.gainDb !== null ? preferred : fallback
  if (chosen.gainDb === null) return 1
  let gain = 10 ** (chosen.gainDb / 20)
  if (chosen.peak !== null && chosen.peak > 0) gain = Math.min(gain, 1 / chosen.peak)
  if (!context.canBoost) gain = Math.min(gain, 1)
  return gain
}
