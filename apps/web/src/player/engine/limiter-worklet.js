// The true-peak limiter at the end of the browser engines' audio graph, as an AudioWorklet
// module. A plain file of its own: the Content-Security-Policy loads worklets (they count as
// scripts) from the server only, and the worklet scope runs no bundler code. The DSP is the
// iOS engine's (apps/mobile/modules/audio-engine/core/Sources/SquirmyAudioCore/Limiter.swift),
// made to run on a stream: a worklet sees 128 frames at a time and none after them, so it
// looks ahead by delaying its output instead, by `delay` frames (1.7 ms at 44.1 kHz).
//
// - Peaks are found 4x oversampled: three points between each pair of frames, read through a
//   Kaiser-windowed sinc, as well as the frames themselves.
// - The gain a peak needs is held for 10 ms, then released over 50 to 150 ms (slower the more
//   it was turning down), and averaged over the 1.5 ms lookahead before it, so it ramps down
//   ahead of the peak and is all the way down when the peak plays.
// - While nothing reaches the ceiling its gain is exactly 1 and samples pass untouched, bit for
//   bit (delayed); after a peak it comes back to exactly 1.

const CEILING_DB = -1
/** 4x oversampling can miss part of a peak on the highest frequencies; it aims this far under the ceiling. */
const MARGIN_DB = 0.1
/** Frames each side of an interpolated point that the interpolator reads. */
const REACH = 8
const LOOKAHEAD_SECONDS = 0.0015
const HOLD_SECONDS = 0.01
const RELEASE_FAST_SECONDS = 0.05
const RELEASE_SLOW_SECONDS = 0.15
/** The reduction at which the release is slowest: 6 dB, a gain of one half. */
const SLOWEST_AT = 0.5

export const LIMITER_PROCESSOR = 'squirmy-limiter'
export const LIMITER_CEILING_DB = CEILING_DB

/** A Kaiser-windowed sinc for the point `offset` (0 to 1) of the way from one frame to the next, unity at 0 Hz. */
function kernel(offset) {
  const beta = 6
  const taps = new Float64Array(REACH * 2)
  let total = 0
  for (let index = 0; index < taps.length; index += 1) {
    const distance = index - (REACH - 1) - offset
    const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance)
    const edge = distance / REACH
    taps[index] = sinc * besselI0(beta * Math.sqrt(1 - edge * edge)) / besselI0(beta)
    total += taps[index]
  }
  for (let index = 0; index < taps.length; index += 1) taps[index] /= total
  return taps
}

function besselI0(x) {
  let sum = 1
  let term = 1
  for (let k = 1; k < 32; k += 1) {
    term *= (x / 2) * (x / 2) / (k * k)
    sum += term
    if (term < sum * 1e-12) break
  }
  return sum
}

export class TruePeakLimiter {
  constructor(sampleRate) {
    this.lookahead = Math.max(1, Math.round(LOOKAHEAD_SECONDS * sampleRate))
    this.hold = Math.max(this.lookahead, Math.round(HOLD_SECONDS * sampleRate))
    /** Frames the output lags the input: the lookahead and the interpolator's reach. */
    this.delay = this.lookahead + REACH - 1
    this.aim = 10 ** ((CEILING_DB - MARGIN_DB) / 20)
    this.kernels = [0.25, 0.5, 0.75].map(kernel)
    // No interpolated point can be larger than the largest sample times this.
    this.overshoot = Math.max(1, ...this.kernels.map(taps => taps.reduce((sum, tap) => sum + Math.abs(tap), 0)))
    this.releaseFast = Math.exp(-1 / (RELEASE_FAST_SECONDS * sampleRate))
    this.releaseSlow = Math.exp(-1 / (RELEASE_SLOW_SECONDS * sampleRate))
    // The input, for the interpolator behind the newest frame and the delayed output.
    let size = 1
    while (size < this.delay + REACH * 2 + 1) size *= 2
    this.mask = size - 1
    this.left = new Float32Array(size)
    this.right = new Float32Array(size)
    /** Frames taken in so far. */
    this.frame = 0
    /** Interpolation is needed until this frame: a sample loud enough to matter is in its window. */
    this.loudUntil = -1
    this.lastPeak = 0
    // The gains the last `hold` frames needed under 1, smallest first (a sliding minimum).
    this.heldFrames = new Float64Array(this.hold + 1)
    this.heldGains = new Float64Array(this.hold + 1)
    this.heldFirst = 0
    this.heldCount = 0
    // In double precision: near 1, a float's steps are too coarse for the release to get all the way back.
    this.level = 1
    // The gains of the last `lookahead` frames, averaged for the frame that plays.
    this.gains = new Float64Array(this.lookahead).fill(1)
    this.gainIndex = 0
    this.sum = this.lookahead
    this.under = 0
    this.outLeft = 0
    this.outRight = 0
  }

  /** How far it is turning the output down right now, as a linear gain: 1 at rest. */
  get gain() {
    return this.under > 0 ? Math.min(1, this.sum / this.lookahead) : 1
  }

  /**
   * Limits one block. `inLeft` and `inRight` may be missing (no input: silence) or the same
   * array (mono); `outRight` may be missing (a mono output). Output lags input by `delay`.
   */
  process(inLeft, inRight, outLeft, outRight) {
    const frames = outLeft.length
    for (let index = 0; index < frames; index += 1) {
      const left = inLeft ? inLeft[index] : 0
      const right = inRight ? inRight[index] : left
      this.step(left, right)
      outLeft[index] = this.outLeft
      if (outRight) outRight[index] = this.outRight
    }
  }

  /** Takes one frame in and puts the frame `delay` before it in `outLeft` and `outRight` (no arrays: the audio thread must not allocate). */
  step(left, right) {
    const mask = this.mask
    const n = this.frame
    this.left[n & mask] = left
    this.right[n & mask] = right
    this.frame = n + 1
    // A sample under aim / overshoot can make no point over the aim, wherever it falls.
    if (Math.max(Math.abs(left), Math.abs(right)) * this.overshoot > this.aim) this.loudUntil = n + REACH * 2
    // The peak of frame k (and the points before it) needs the frames up to k + REACH - 1.
    const k = n - REACH + 1
    const peak = n < this.loudUntil ? this.truePeak(k) : 0
    // The gain frame k - 1 needs, for itself and the points on either side of it.
    const loudest = Math.max(this.lastPeak, peak)
    this.lastPeak = peak
    const need = loudest > this.aim ? this.aim / loudest : 1
    const j = k - 1
    const held = this.holdGain(j, need)
    if (this.level < 1) {
      const depth = Math.min(1, (1 - this.level) / (1 - SLOWEST_AT))
      const coefficient = this.releaseFast + (this.releaseSlow - this.releaseFast) * depth
      this.level = 1 - (1 - this.level) * coefficient
      // Back at rest exactly, so what follows passes untouched.
      if (this.level > 1 - 1e-6) this.level = 1
    }
    if (held < this.level) this.level = held
    // The frame that plays now takes the average over the lookahead after it.
    const leaving = this.gains[this.gainIndex]
    this.gains[this.gainIndex] = this.level
    this.gainIndex = (this.gainIndex + 1) % this.lookahead
    this.sum += this.level - leaving
    this.under += (this.level < 1 ? 1 : 0) - (leaving < 1 ? 1 : 0)
    if (this.under === 0) this.sum = this.lookahead
    const out = (n - this.delay) & mask
    if (this.under === 0) {
      this.outLeft = this.left[out]
      this.outRight = this.right[out]
      return
    }
    const gain = Math.min(1, this.sum / this.lookahead)
    this.outLeft = this.left[out] * gain
    this.outRight = this.right[out] * gain
  }

  /** The smallest gain needed over the `hold` frames up to `frame`, with `need` for that frame. */
  holdGain(frame, need) {
    const size = this.heldFrames.length
    if (need < 1) {
      // Gains no smaller than this one can never be the minimum again.
      while (this.heldCount > 0 && this.heldGains[(this.heldFirst + this.heldCount - 1) % size] >= need) this.heldCount -= 1
      const slot = (this.heldFirst + this.heldCount) % size
      this.heldFrames[slot] = frame
      this.heldGains[slot] = need
      this.heldCount += 1
    }
    while (this.heldCount > 0 && this.heldFrames[this.heldFirst] <= frame - this.hold) {
      this.heldFirst = (this.heldFirst + 1) % size
      this.heldCount -= 1
    }
    return this.heldCount > 0 ? this.heldGains[this.heldFirst] : 1
  }

  /** The largest of frame `k` and the three points between it and the frame before, over both channels. */
  truePeak(k) {
    const mask = this.mask
    let peak = Math.max(Math.abs(this.left[k & mask]), Math.abs(this.right[k & mask]))
    const first = k - REACH
    for (const taps of this.kernels) {
      let left = 0
      let right = 0
      for (let tap = 0; tap < taps.length; tap += 1) {
        const at = (first + tap) & mask
        left += this.left[at] * taps[tap]
        right += this.right[at] * taps[tap]
      }
      peak = Math.max(peak, Math.abs(left), Math.abs(right))
    }
    return peak
  }
}

// In the audio worklet scope only; tests import the limiter above on its own.
if (typeof AudioWorkletProcessor === 'function') {
  class LimiterProcessor extends AudioWorkletProcessor {
    constructor() {
      super()
      // `sampleRate` is the worklet scope's: the context's rate.
      this.limiter = new TruePeakLimiter(sampleRate)
    }

    process(inputs, outputs) {
      const input = inputs[0] ?? []
      const output = outputs[0] ?? []
      if (output[0]) this.limiter.process(input[0] ?? null, input[1] ?? input[0] ?? null, output[0], output[1] ?? null)
      // Kept running with no input, so what is still in the delay plays out.
      return true
    }
  }
  registerProcessor(LIMITER_PROCESSOR, LimiterProcessor)
}
