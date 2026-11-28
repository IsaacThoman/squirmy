import { describe, expect, it } from 'vitest'
import { beatSamples, chords, type BeatSpec } from '../../test/audio.js'
import { SonicAnalyzer, VECTOR_LENGTH, type SonicFeatures } from './dsp/analyzer.js'
import { RealFft } from './dsp/fft.js'

/** Analyses samples fed in uneven chunks, as a pipe delivers them. */
function analyze(spec: BeatSpec): SonicFeatures {
  const samples = beatSamples(spec)
  const analyzer = new SonicAnalyzer()
  for (let offset = 0, size = 3001; offset < samples.length; offset += size, size = size === 3001 ? 16384 : 3001) {
    analyzer.push(samples.subarray(offset, offset + size))
  }
  return analyzer.finish()!
}

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const size = 64
    const fft = new RealFft(size)
    const input = Float64Array.from({ length: size }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + (i % 5) * 0.1)
    const power = new Float64Array(size / 2 + 1)
    fft.power(input, power)
    for (let k = 0; k <= size / 2; k++) {
      let re = 0
      let im = 0
      for (let n = 0; n < size; n++) {
        re += input[n]! * Math.cos((2 * Math.PI * k * n) / size)
        im -= input[n]! * Math.sin((2 * Math.PI * k * n) / size)
      }
      expect(power[k]).toBeCloseTo(re * re + im * im, 6)
    }
  })
})

describe('sonic analysis', () => {
  it.each([72, 90, 120, 128, 140])('finds the tempo of a %d BPM click track', (bpm) => {
    const features = analyze({ durationSec: 40, bpm, chords: chords.cMajor })
    expect(features.bpm).toBeCloseTo(bpm, 0)
    expect(features.bpmConfidence).toBeGreaterThan(0.6)
  })

  it('may give a fast tempo as half time, never anything else', () => {
    // Equal clicks at 174 BPM are as much 87 BPM as 174: the octave is a matter of taste,
    // and radio's tempo continuity treats both as the same tempo.
    const { bpm } = analyze({ durationSec: 40, bpm: 174 })
    expect([87, 174].some((tempo) => Math.abs(bpm! - tempo) < 0.5)).toBe(true)
  })

  it('places the beat grid on the clicks', () => {
    const features = analyze({ durationSec: 40, bpm: 100, firstBeatSec: 0.43 })
    // 600 ms beats; the first falls at 430 ms.
    expect(Math.abs(features.beatOffsetMs! - 430)).toBeLessThan(30)
  })

  it('keeps tempo through noise and finds none in noise alone', () => {
    expect(analyze({ durationSec: 40, bpm: 124, noise: 0.05 }).bpm).toBeCloseTo(124, 0)
    const noise = analyze({ durationSec: 40, noise: 0.2 })
    expect(noise.bpm === null || noise.bpmConfidence < 0.3).toBe(true)
    expect(noise.danceability!).toBeLessThan(0.3)
  })

  it('finds the key of a chord progression', () => {
    const major = analyze({ durationSec: 32, chords: chords.cMajor })
    expect({ key: major.key, mode: major.mode }).toEqual({ key: 0, mode: 'major' })
    const minor = analyze({ durationSec: 32, chords: chords.aMinor })
    expect({ key: minor.key, mode: minor.mode }).toEqual({ key: 9, mode: 'minor' })
    expect(minor.keyStrength).toBeGreaterThan(0.6)
  })

  it('corrects for tuning that is a little off', () => {
    const sharp = chords.cMajor.map((chord) => chord.map((hz) => hz * 2 ** (35 / 1200)))
    const features = analyze({ durationSec: 32, chords: sharp })
    expect({ key: features.key, mode: features.mode }).toEqual({ key: 0, mode: 'major' })
    expect(Math.abs(features.tuningCents! - 35)).toBeLessThan(10)
  })

  it('finds the audible part, the intro and the outro', () => {
    const features = analyze({ durationSec: 40, bpm: 120, chords: chords.cMajor, silenceSec: 2, fadeInSec: 6, fadeOutSec: 8 })
    expect(Math.abs(features.audibleStartMs! - 2000)).toBeLessThan(400)
    expect(Math.abs(features.audibleEndMs! - 42_000)).toBeLessThan(400)
    // Fades are linear in amplitude: the level reaches 6 dB below full at half amplitude.
    expect(Math.abs(features.introEndMs! - (2000 + 3000))).toBeLessThan(800)
    expect(Math.abs(features.outroStartMs! - (42_000 - 4000))).toBeLessThan(800)
  })

  it('starts the intro and the outro at the ends of a track without fades', () => {
    const features = analyze({ durationSec: 20, bpm: 120, chords: chords.cMajor })
    expect(features.introEndMs).toBe(features.audibleStartMs)
    expect(features.outroStartMs).toBe(features.audibleEndMs)
  })

  it('rates a fast bright track above a slow dull one for energy', () => {
    const calm = analyze({ durationSec: 30, bpm: 70, clickHz: 300, chords: chords.aMinor, volumeDb: -34 })
    const lively = analyze({ durationSec: 30, bpm: 128, clickHz: 3000, noise: 0.03, volumeDb: -20 })
    expect(lively.energy!).toBeGreaterThan(calm.energy!)
    expect(lively.onsetRate).toBeGreaterThan(calm.onsetRate)
    expect(lively.danceability!).toBeGreaterThan(calm.danceability!)
  })

  it('describes timbre with a vector of fixed length', () => {
    const features = analyze({ durationSec: 20, bpm: 120, chords: chords.cMajor })
    expect(features.vector).toHaveLength(VECTOR_LENGTH)
    expect(features.vector!.every(Number.isFinite)).toBe(true)
  })

  it('reports nothing measurable for silence', () => {
    const features = analyze({ durationSec: 5 })
    expect(features).toMatchObject({ bpm: null, key: null, energy: null, audibleStartMs: null, vector: null })
    expect(new SonicAnalyzer().finish()).toBeNull()
  })
})
