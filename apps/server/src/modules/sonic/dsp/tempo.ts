/**
 * Tempo and beat phase from an onset-strength envelope (one value per analysis frame).
 *
 * 1. Autocorrelate the envelope in overlapping windows of about nine seconds, each with
 *    its mean removed and normalized by its energy, and average them. Averaging local
 *    autocorrelations tolerates the drift of a live drummer better than one global one.
 * 2. Weight lags by a log-normal prior centred on 120 BPM, one octave wide (as librosa
 *    does), and take the best peak between 40 and 240 BPM. The prior decides between the
 *    peaks a steady pulse has at every multiple of its period, the usual octave ambiguity.
 * 3. Refine the period with a comb: the period (within 3% of the estimate) and offset
 *    whose beats land on the most onset strength over the whole track, searched coarse
 *    and then fine. Frame resolution alone would be about 5 BPM at 120 BPM.
 * 4. Fit the phase of that grid to the first 30 seconds.
 *
 * `clarity` is the averaged autocorrelation at the period: near 1 for a metronome, about
 * 0.1 or less for music without a steady pulse.
 */

export type Tempo = {
  bpm: number
  /** 0..1, how steady and pronounced the pulse is. */
  clarity: number
  /** First beat, in frames from the start of the envelope. */
  phaseFrames: number
}

const MIN_BPM = 40
const MAX_BPM = 240
const PRIOR_BPM = 120
const PRIOR_OCTAVES = 1
const WINDOW_SECONDS = 8.9
const WINDOW_HOP_SECONDS = 3
/** Below this averaged autocorrelation there is no pulse worth reporting. */
const MIN_CLARITY = 0.04
const REFINE_SPAN = 0.03
const REFINE_STEPS = 60
const PHASE_STEP_FRAMES = 0.25
/** The beat phase is fitted to this much of the start. */
const PHASE_SECONDS = 30
/**
 * Tempo is found from this much of the start: plenty for a precise period, and it bounds
 * the work done in one go (on the event loop) for a half-hour mix.
 */
const TEMPO_SECONDS = 600

/** Linear interpolation of `values` at a fractional index. */
function at(values: Float32Array, index: number): number {
  const i = Math.floor(index)
  if (i < 0 || i >= values.length - 1) return i === values.length - 1 ? values[i]! : 0
  const fraction = index - i
  return values[i]! * (1 - fraction) + values[i + 1]! * fraction
}

/** Averaged, normalized autocorrelation of the envelope for lags 0..maxLag. */
export function windowedAutocorrelation(envelope: Float32Array, fps: number, maxLag: number): Float64Array | null {
  const length = Math.min(envelope.length, Math.round(WINDOW_SECONDS * fps))
  if (length <= maxLag + 1) return null
  const hop = Math.max(1, Math.round(WINDOW_HOP_SECONDS * fps))
  const sum = new Float64Array(maxLag + 1)
  const frame = new Float64Array(length)
  let windows = 0
  for (let start = 0; start + length <= envelope.length; start += hop) {
    let mean = 0
    for (let i = 0; i < length; i++) mean += envelope[start + i]!
    mean /= length
    let energy = 0
    for (let i = 0; i < length; i++) {
      const value = envelope[start + i]! - mean
      frame[i] = value
      energy += value * value
    }
    if (energy <= 1e-12) continue
    for (let lag = 0; lag <= maxLag; lag++) {
      let acc = 0
      for (let i = 0; i + lag < length; i++) acc += frame[i]! * frame[i + lag]!
      // Unbiased: shorter overlaps at long lags are not penalized.
      sum[lag]! += (acc / energy) * (length / (length - lag))
    }
    windows++
  }
  if (windows === 0) return null
  for (let lag = 0; lag <= maxLag; lag++) sum[lag]! /= windows
  return sum
}

/** Peak position refined by fitting a parabola through the neighbours. */
function refinePeak(values: Float64Array, index: number): number {
  if (index <= 0 || index >= values.length - 1) return index
  const a = values[index - 1]!
  const b = values[index]!
  const c = values[index + 1]!
  const denominator = a - 2 * b + c
  return denominator < 0 ? index + (0.5 * (a - c)) / denominator : index
}

/** Mean onset strength on a beat grid of `period` frames starting at `phase`. */
function combScore(envelope: Float32Array, period: number, phase: number): number {
  let total = 0
  let count = 0
  for (let t = phase; t < envelope.length - 1; t += period) {
    total += at(envelope, t)
    count++
  }
  return count ? total / count : 0
}

/**
 * The envelope blurred over five frames. Sharp onsets give autocorrelation peaks a frame
 * wide, which integer lags can miss: a period of 18.5 frames would score below its double.
 */
function smooth(envelope: Float32Array): Float32Array {
  const kernel = [1, 2, 3, 2, 1]
  const out = new Float32Array(envelope.length)
  for (let i = 0; i < envelope.length; i++) {
    let sum = 0
    let weight = 0
    for (let k = -2; k <= 2; k++) {
      const value = envelope[i + k]
      if (value === undefined) continue
      sum += value * kernel[k + 2]!
      weight += kernel[k + 2]!
    }
    out[i] = sum / weight
  }
  return out
}

export function estimateTempo(whole: Float32Array, fps: number): Tempo | null {
  const envelope = whole.subarray(0, Math.round(TEMPO_SECONDS * fps))
  const minLag = Math.floor((60 * fps) / MAX_BPM)
  const maxLag = Math.ceil((60 * fps) / MIN_BPM)
  const acf = windowedAutocorrelation(smooth(envelope), fps, maxLag + 1)
  if (!acf) return null

  let best = -1
  let bestScore = -Infinity
  for (let lag = Math.max(1, minLag); lag <= maxLag; lag++) {
    const value = acf[lag]!
    // Only local peaks: the slope down from lag 0 is not a period.
    if (!(value > acf[lag - 1]! && value >= acf[lag + 1]!)) continue
    const bpm = (60 * fps) / lag
    const octaves = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES
    const score = value * Math.exp(-0.5 * octaves * octaves)
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  if (best < 0) return null
  const clarity = acf[best]!
  if (clarity < MIN_CLARITY) return null
  const coarse = refinePeak(acf, best)

  // Coarse then fine: over a few hundred beats, a period off by a hundredth of a frame
  // drifts the grid by several frames, so the period needs far finer steps than the phase.
  let span = coarse * REFINE_SPAN
  let period = coarse
  for (const phaseStep of [0.5, PHASE_STEP_FRAMES]) {
    const centre = period
    let bestComb = -Infinity
    for (let step = -REFINE_STEPS / 2; step <= REFINE_STEPS / 2; step++) {
      const candidate = centre + (span * 2 * step) / REFINE_STEPS
      for (let offset = 0; offset < candidate; offset += phaseStep) {
        const score = combScore(envelope, candidate, offset)
        if (score > bestComb) {
          bestComb = score
          period = candidate
        }
      }
    }
    span = (span * 2) / REFINE_STEPS
  }
  // The phase near the start, where a transition into the track needs it.
  const opening = envelope.subarray(0, Math.min(envelope.length, Math.round(PHASE_SECONDS * fps)))
  let phase = 0
  let bestPhase = -Infinity
  for (let offset = 0; offset < period; offset += 0.1) {
    const score = combScore(opening, period, offset)
    if (score > bestPhase) {
      bestPhase = score
      phase = offset
    }
  }
  return { bpm: (60 * fps) / period, clarity: Math.min(1, clarity), phaseFrames: phase }
}
