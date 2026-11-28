import { describe, expect, it } from 'vitest'
import { LIMITER_CEILING_DB, TruePeakLimiter } from './limiter-worklet.js'

// The iOS engine's limiter tests (LimiterTests.swift), run on the worklet's DSP. Signals are
// split channels of 32-bit floats, as a worklet gets them.
type Stereo = [Float32Array, Float32Array]

const ceiling = LIMITER_CEILING_DB
const db = (value: number) => 10 ** (value / 20)

/** A full-scale sine on both channels. */
function tone(frequency: number, rate: number, seconds: number, phase = 0): Stereo {
  const frames = Math.round(rate * seconds)
  const left = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) left[frame] = Math.sin(2 * Math.PI * frequency * frame / rate + phase)
  return [left, left.slice()]
}

/** A full-scale sweep, a different one on each channel. */
function sweep(rate: number, seconds: number): Stereo {
  const at = (t: number, from: number, to: number) => Math.sin(2 * Math.PI * (from * t + (to - from) / (2 * seconds) * t * t))
  const frames = Math.round(rate * seconds)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = at(frame / rate, 220, 1760)
    right[frame] = at(frame / rate, 1320, 330)
  }
  return [left, right]
}

const scale = ([left, right]: Stereo, gain: number, from = 0, to = left.length): Stereo => {
  const out: Stereo = [left.slice(), right.slice()]
  for (let frame = from; frame < to; frame += 1) {
    out[0][frame] = left[frame]! * gain
    out[1][frame] = right[frame]! * gain
  }
  return out
}

/**
 * Runs `signal` through a limiter `block` frames at a time, as a worklet does, then the
 * limiter's delay of silence to play out what it holds; returns the output lined up with the input.
 */
function limit([left, right]: Stereo, rate: number, block = 128): Stereo {
  const limiter = new TruePeakLimiter(rate)
  const total = left.length + limiter.delay
  const out: Stereo = [new Float32Array(total + block), new Float32Array(total + block)]
  for (let frame = 0; frame < total; frame += block) {
    const inLeft = new Float32Array(block)
    const inRight = new Float32Array(block)
    inLeft.set(left.subarray(frame, frame + block))
    inRight.set(right.subarray(frame, frame + block))
    const outLeft = new Float32Array(block)
    const outRight = new Float32Array(block)
    limiter.process(inLeft, inRight, outLeft, outRight)
    out[0].set(outLeft, frame)
    out[1].set(outRight, frame)
  }
  return [out[0].slice(limiter.delay, limiter.delay + left.length), out[1].slice(limiter.delay, limiter.delay + left.length)]
}

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 40; k += 1) {
    term *= (x / 2) * (x / 2) / (k * k)
    sum += term
  }
  return sum
}

/**
 * The true peak in dBTP, 4x oversampled as BS.1770 measures it. Its interpolator is its own,
 * four times as long as the limiter's, so the two do not share their mistakes.
 */
function truePeakDb(signal: Stereo): number {
  const reach = 32
  const kernels = [0.25, 0.5, 0.75].map(offset => {
    const taps = Array.from({ length: reach * 2 }, (_, index) => {
      const distance = index - (reach - 1) - offset
      const edge = distance / reach
      return Math.sin(Math.PI * distance) / (Math.PI * distance) * besselI0(9 * Math.sqrt(1 - edge * edge))
    })
    const total = taps.reduce((sum, tap) => sum + tap, 0)
    return taps.map(tap => tap / total)
  })
  let peak = 0
  for (const channel of signal) {
    for (let frame = 0; frame < channel.length; frame += 1) {
      peak = Math.max(peak, Math.abs(channel[frame]!))
      for (const taps of kernels) {
        let point = 0
        for (let tap = 0; tap < taps.length; tap += 1) point += (channel[frame - reach + tap] ?? 0) * taps[tap]!
        peak = Math.max(peak, Math.abs(point))
      }
    }
  }
  return 20 * Math.log10(peak)
}

const largestDb = (signal: Stereo) => 20 * Math.log10(Math.max(...signal.map(channel => channel.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0))))

/** The gain each frame was played at, where the input is loud enough to tell. */
function gainsApplied(output: Stereo, input: Stereo): { frame: number; gain: number }[] {
  const gains: { frame: number; gain: number }[] = []
  for (let frame = 0; frame < input[0].length; frame += 1) {
    if (Math.abs(input[0][frame]!) > 0.05) gains.push({ frame, gain: output[0][frame]! / input[0][frame]! })
  }
  return gains
}

describe('the true-peak limiter', () => {
  it.each([44_100, 48_000])('keeps a full-scale tone boosted 12 dB under -1 dBTP, and close to it, at %i Hz', rate => {
    for (const frequency of [60, 1000, 9000]) {
      const limited = limit(scale(tone(frequency, rate, 1.5), db(12)), rate)
      const peak = truePeakDb(limited)
      expect(peak, `${frequency} Hz`).toBeLessThan(ceiling)
      // Down to the ceiling, not far below it.
      expect(peak, `${frequency} Hz`).toBeGreaterThan(ceiling - 0.5)
    }
  })

  it('catches peaks between the samples', () => {
    // A quarter of the sample rate, 45° off the samples: every sample is 3 dB under the wave's
    // own peak, so a limiter that read the samples alone would let it through 3 dB over.
    const rate = 44_100
    const wave = tone(rate / 4, rate, 1, Math.PI / 4)
    expect(truePeakDb(wave) - largestDb(wave)).toBeGreaterThan(2.95)
    expect(truePeakDb(limit(scale(wave, db(1)), rate))).toBeLessThan(ceiling)
  })

  it('passes a signal under the ceiling bit-identical', () => {
    const rate = 48_000
    // Quiet, and just under the ceiling (where every peak is looked at, and none needs turning down).
    for (const level of [-40, -1.6]) {
      const signal = scale(sweep(rate, 2), db(level))
      expect(truePeakDb(signal)).toBeLessThan(ceiling - 0.1)
      const limited = limit(signal, rate)
      expect(limited[0], `${level} dB`).toEqual(signal[0])
      expect(limited[1], `${level} dB`).toEqual(signal[1])
    }
  })

  it('comes back to untouched after a peak', () => {
    const rate = 48_000
    // A loud two seconds, 6 dB over full scale, between quiet ones.
    const quiet = scale(sweep(rate, 6), db(-20))
    const signal = scale(quiet, db(26), rate * 2, rate * 4)
    const limited = limit(signal, rate)
    expect(truePeakDb(limited)).toBeLessThan(ceiling)
    // Untouched until the lookahead before the burst, and again once it has recovered.
    const before = rate * 2 - 200
    expect(limited[0].subarray(0, before)).toEqual(signal[0].subarray(0, before))
    const after = rate * 4 + Math.round(rate * 1.2)
    expect(limited[0].subarray(after), 'the gain did not come back to exactly 1').toEqual(signal[0].subarray(after))
    expect(limited[1].subarray(after)).toEqual(signal[1].subarray(after))
  })

  it('ramps down ahead of a peak instead of jumping', () => {
    const rate = 48_000
    // A quiet tone that becomes 12 dB over the ceiling from one sample to the next.
    const step = rate / 2
    const signal = scale(scale(tone(440, rate, 1), db(-12)), db(24), step)
    const limited = limit(signal, rate)
    expect(truePeakDb(limited)).toBeLessThan(ceiling)
    const gains = gainsApplied(limited, signal)
    const lookahead = Math.round(0.0015 * rate)
    let steepest = 0
    for (let index = 1; index < gains.length; index += 1) {
      steepest = Math.max(steepest, Math.abs(gains[index]!.gain - gains[index - 1]!.gain) / (gains[index]!.frame - gains[index - 1]!.frame))
    }
    // From 1 to about a quarter: spread over the lookahead, not in one sample.
    expect(steepest).toBeLessThan(1.5 / lookahead)
    expect(gains.some(({ frame, gain }) => frame < step && gain < 0.9), 'it did not turn down ahead of the step').toBe(true)
  })

  it('holds steady on a sustained tone without pumping', () => {
    const rate = 48_000
    for (const frequency of [60, 1000]) {
      const signal = scale(tone(frequency, rate, 2), db(12))
      const gains = gainsApplied(limit(signal, rate), signal).filter(({ frame }) => frame > rate * 0.2).map(({ gain }) => gain)
      const swing = 20 * Math.log10(Math.max(...gains) / Math.min(...gains))
      expect(swing, `${frequency} Hz: the gain moves with the waveform`).toBeLessThan(0.05)
    }
  })

  it('gives the same output whatever the block size', () => {
    const rate = 44_100
    const signal = scale(sweep(rate, 2), db(9))
    const long = limit(signal, rate, 128)
    const short = limit(signal, rate, 37)
    expect(long).toEqual(short)
  })

  it('lags by its lookahead and the interpolator, under 2 ms', () => {
    expect(new TruePeakLimiter(44_100).delay).toBe(73)
    expect(new TruePeakLimiter(48_000).delay).toBe(79)
    expect(new TruePeakLimiter(48_000).delay / 48_000).toBeLessThan(0.002)
  })

  it('plays silence when it has no input', () => {
    const limiter = new TruePeakLimiter(48_000)
    const left = new Float32Array(128).fill(1)
    const right = new Float32Array(128).fill(1)
    limiter.process(null, null, left, right)
    expect([...left, ...right].every(sample => sample === 0)).toBe(true)
  })
})
