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
  return appliedGain(mode, normalization, context).gain
}

/**
 * `gainFor`, and which of the two gains it comes from: null when it is 1 for want of one
 * (`off`, or no data). A gain the peak or `canBoost` holds back to 1 still names its source.
 */
export function appliedGain(mode: NormalizationMode, normalization: Normalization | null | undefined, context: GainContext): { gain: number; applied: 'track' | 'album' | null } {
  if (mode === 'off' || !normalization) return { gain: 1, applied: null }
  const album = mode === 'album' || (mode === 'auto' && context.albumContext)
  const track = { gainDb: normalization.trackGainDb, peak: normalization.trackPeak, source: 'track' as const }
  const whole = { gainDb: normalization.albumGainDb, peak: normalization.albumPeak, source: 'album' as const }
  const [preferred, fallback] = album ? [whole, track] : [track, whole]
  const chosen = preferred.gainDb !== null ? preferred : fallback
  if (chosen.gainDb === null) return { gain: 1, applied: null }
  let gain = 10 ** (chosen.gainDb / 20)
  if (chosen.peak !== null && chosen.peak > 0) gain = Math.min(gain, 1 / chosen.peak)
  if (!context.canBoost) gain = Math.min(gain, 1)
  return { gain, applied: chosen.source }
}
