/** Types for limiter-worklet.js, which is plain JavaScript so it can load in the audio worklet scope as it is. */

/** The name the worklet registers its processor under. */
export declare const LIMITER_PROCESSOR: string
/** Its ceiling, in dBTP. */
export declare const LIMITER_CEILING_DB: number

/** The true-peak limiter on a stream of stereo frames; its output lags its input by `delay` frames. */
export declare class TruePeakLimiter {
  constructor(sampleRate: number)
  readonly lookahead: number
  readonly delay: number
  /** How far it is turning the output down right now, as a linear gain: 1 at rest. */
  readonly gain: number
  process(inLeft: Float32Array | null, inRight: Float32Array | null, outLeft: Float32Array, outRight: Float32Array | null): void
}
