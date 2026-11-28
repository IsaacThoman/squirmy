import type { Normalization, NormalizationMode } from '@squirmy/contracts'

/** The loudness `Normalization`'s gains bring a song to, in LUFS (ReplayGain 2.0). */
export const REFERENCE_LUFS = -18

/** The ceiling of the engines' true-peak limiter, in dBTP. */
export const LIMITER_CEILING_DB = -1

export type GainContext = {
  /**
   * The entry is played as part of its album, in album order (the session's context is
   * that album and shuffle is off). Decides album versus track gain in `auto` mode.
   */
  albumContext: boolean
  /** The output can amplify above unity (Web Audio gain can; a plain volume cannot). */
  canBoost: boolean
  /**
   * A true-peak limiter follows the gain (the iOS native engine's), so the gain is not held
   * back to the song's peak: the limiter keeps the loudest moments under its ceiling instead.
   * Defaults to false.
   */
  limiter?: boolean
  /** The loudness to bring songs to, in LUFS (the user's setting). Defaults to `REFERENCE_LUFS`. */
  targetLufs?: number
}

export type AppliedGain = {
  gain: number
  /** Which of the two gains it comes from: null when it is 1 for want of one (`off`, or no data). */
  applied: 'track' | 'album' | null
  /**
   * With a limiter: how far it turns the song's loudest peak down at this gain, in dB, 0 when
   * none reaches its ceiling and null when the song's peak is unknown. Absent without a
   * limiter, or when no gain applies.
   */
  limitDb?: number | null
}

/**
 * Linear gain multiplier for loudness normalization.
 *
 * - `off`, or no normalization data: 1.
 * - `track` uses the track gain, `album` the album gain; each falls back to the other
 *   when its own value is missing, and to 1 when both are.
 * - `auto` is `album` when `albumContext` and `track` otherwise.
 * - The gain is moved by the target's distance from the -18 LUFS reference: -14 is 4 dB
 *   louder.
 *
 * Without a limiter the result never exceeds `1 / peak` of the chosen value (so it cannot
 * clip), and a track gain the server estimated (`estimated`: its peak is unknown) never
 * exceeds 1. With one, the limiter takes care of peaks and neither applies. Never above 1
 * when `canBoost` is false.
 */
export function gainFor(mode: NormalizationMode, normalization: Normalization | null | undefined, context: GainContext): number {
  return appliedGain(mode, normalization, context).gain
}

/**
 * `gainFor`, which of the two gains it comes from, and what the limiter does to the song at
 * it. A gain the peak or `canBoost` holds back to 1 still names its source.
 */
export function appliedGain(mode: NormalizationMode, normalization: Normalization | null | undefined, context: GainContext): AppliedGain {
  if (mode === 'off' || !normalization) return { gain: 1, applied: null }
  const album = mode === 'album' || (mode === 'auto' && context.albumContext)
  const track = { gainDb: normalization.trackGainDb, peak: normalization.trackPeak, source: 'track' as const }
  const whole = { gainDb: normalization.albumGainDb, peak: normalization.albumPeak, source: 'album' as const }
  const [preferred, fallback] = album ? [whole, track] : [track, whole]
  const chosen = preferred.gainDb !== null ? preferred : fallback
  if (chosen.gainDb === null) return { gain: 1, applied: null }
  let gain = 10 ** ((chosen.gainDb + (context.targetLufs ?? REFERENCE_LUFS) - REFERENCE_LUFS) / 20)
  if (!context.limiter) {
    if (chosen.peak !== null && chosen.peak > 0) gain = Math.min(gain, 1 / chosen.peak)
    else if (chosen.source === 'track' && normalization.estimated) gain = Math.min(gain, 1)
  }
  if (!context.canBoost) gain = Math.min(gain, 1)
  if (!context.limiter) return { gain, applied: chosen.source }
  // The song's own peak, whichever gain applies: an album's peak is its loudest song's.
  const peak = normalization.trackPeak
  const limitDb = peak !== null && peak > 0 ? Math.max(0, 20 * Math.log10(gain * peak) - LIMITER_CEILING_DB) : null
  return { gain, applied: chosen.source, limitDb }
}
