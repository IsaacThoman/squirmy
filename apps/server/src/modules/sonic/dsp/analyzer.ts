/**
 * Squirmy's own audio analysis: features of a track from mono PCM at `SAMPLE_RATE`, fed in
 * chunks as ffmpeg decodes it, so memory stays flat and the event loop is never held for
 * long (each chunk is a few milliseconds of work).
 *
 * Per frame of `FRAME` samples every `HOP` (93 ms windows, 43 a second), from one FFT:
 * - a 40-band mel spectrum, its 13 MFCCs (timbre) and its positive change from the frame
 *   before (spectral flux, the onset strength that tempo is found from);
 * - spectral centroid, flatness and 85% rolloff, the zero-crossing rate and the level;
 * - spectral peaks between 100 Hz and 5 kHz, added into a 10-cent pitch-class histogram
 *   weighted by the frame's level (key).
 *
 * At the end, tempo and beat phase come from `tempo.ts`, key from `key.ts`, and the rest
 * from the frames that are audible (within 30 dB of the track's typical level):
 * levels, dynamic range, onset rate, the intro and outro, energy, danceability, and the
 * timbre vector similarity is measured with (`VECTOR_LAYOUT`).
 */
import { RealFft } from './fft.js'
import { estimateKey, PITCH_BINS, type Mode } from './key.js'
import { estimateTempo } from './tempo.js'

export const SAMPLE_RATE = 22050
export const FRAME = 2048
export const HOP = 512
export const FPS = SAMPLE_RATE / HOP
const MEL_BANDS = 40
const MEL_MAX_HZ = 8000
const MFCCS = 13
const PEAK_MIN_HZ = 100
const PEAK_MAX_HZ = 5000
/** Peaks quieter than this, relative to the frame's loudest bin, are left out of the key. */
const PEAK_FLOOR_DB = 40
const FLOOR_DB = -100
/** Frames this far below the track's typical level are silence or noise. */
const AUDIBLE_DB = 30
/** The intro ends, and the outro starts, within this many dB of the typical level. */
const BODY_DB = 6
/** Levels are averaged over 400 ms, like EBU R128's momentary loudness. */
const LEVEL_SMOOTH_SECONDS = 0.4
const DYNAMICS_WINDOW_SECONDS = 3
/** Read once: an imported binding in the per-peak loop costs a getter call under the test runner. */
const PITCH_BIN_COUNT = PITCH_BINS

/**
 * What each element of the raw timbre vector holds. Similarity standardizes every element
 * over the library before comparing (`sonic/vectors.ts`), so units do not matter here.
 */
export const VECTOR_LAYOUT = [
  ...Array.from({ length: MFCCS - 1 }, (_, i) => `mfcc${i + 1}Mean`),
  ...Array.from({ length: MFCCS - 1 }, (_, i) => `mfcc${i + 1}Std`),
  'logCentroidMean', 'logCentroidStd', 'flatnessMean', 'logRolloffMean', 'zeroCrossingMean',
  'onsetRate', 'dynamicRange', 'pulseClarity', 'keyStrength', 'level',
] as const
export const VECTOR_LENGTH = VECTOR_LAYOUT.length

export type SonicFeatures = {
  /** How much audio was analysed. */
  analyzedMs: number
  bpm: number | null
  /** 0..1, how steady and pronounced the beat is (0 when there is none). */
  bpmConfidence: number
  /** The first beat, so `beatOffsetMs + n * 60000 / bpm` is the beat grid. */
  beatOffsetMs: number | null
  /** Pitch class of the tonic, 0 = C. */
  key: number | null
  mode: Mode | null
  /** 0..1 correlation with the key profile. */
  keyStrength: number
  /** Deviation of the tuning from A = 440 Hz, in cents. */
  tuningCents: number | null
  /** Mean level of the audible part, dBFS (RMS of the mono mix). */
  levelDb: number | null
  /** Spread of three-second levels, 95th minus 10th percentile, in dB (like EBU loudness range). */
  dynamicRangeDb: number | null
  /** Note and drum onsets per second. */
  onsetRate: number
  /** Mean spectral centroid of the audible part, Hz. */
  centroidHz: number | null
  /** 0..1 perceived intensity: level, onset density and brightness. */
  energy: number | null
  /** 0..1 how danceable: beat clarity, and a tempo people dance to. */
  danceability: number | null
  audibleStartMs: number | null
  audibleEndMs: number | null
  /** Where the track first reaches its typical level; `audibleStartMs` when it starts at it. */
  introEndMs: number | null
  /** Where it last leaves its typical level: the start of a fade or a quiet ending. */
  outroStartMs: number | null
  vector: number[] | null
}

function hzToMel(hz: number) {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number) {
  return 700 * (10 ** (mel / 2595) - 1)
}

type MelFilter = { start: number; weights: Float64Array }

function melFilters(): MelFilter[] {
  const bins = FRAME / 2 + 1
  const binHz = SAMPLE_RATE / FRAME
  const maxMel = hzToMel(MEL_MAX_HZ)
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz((maxMel * i) / (MEL_BANDS + 1)))
  return Array.from({ length: MEL_BANDS }, (_, band) => {
    const [low, centre, high] = [edges[band]!, edges[band + 1]!, edges[band + 2]!]
    const start = Math.max(0, Math.floor(low / binHz))
    const end = Math.min(bins - 1, Math.ceil(high / binHz))
    const weights = new Float64Array(end - start + 1)
    for (let k = start; k <= end; k++) {
      const hz = k * binHz
      const weight = hz <= centre ? (hz - low) / (centre - low) : (high - hz) / (high - centre)
      weights[k - start] = Math.max(0, weight)
    }
    return { start, weights }
  })
}

function dctMatrix(): Float64Array {
  const matrix = new Float64Array(MFCCS * MEL_BANDS)
  for (let i = 0; i < MFCCS; i++) {
    const scale = Math.sqrt((i === 0 ? 1 : 2) / MEL_BANDS)
    for (let j = 0; j < MEL_BANDS; j++) matrix[i * MEL_BANDS + j] = scale * Math.cos((Math.PI * i * (j + 0.5)) / MEL_BANDS)
  }
  return matrix
}

/** A Float32Array that grows by doubling. */
class Series {
  private data: Float32Array
  length = 0
  constructor(private readonly width = 1, capacity = 4096) {
    this.data = new Float32Array(capacity * width)
  }
  push(values: ArrayLike<number>) {
    if ((this.length + 1) * this.width > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    for (let i = 0; i < this.width; i++) this.data[this.length * this.width + i] = values[i]!
    this.length++
  }
  get(index: number, column = 0) {
    return this.data[index * this.width + column]!
  }
  values(): Float32Array {
    return this.data.subarray(0, this.length * this.width)
  }
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const scale = (value: number, low: number, high: number) => clamp01((value - low) / (high - low))
const toDb = (power: number) => (power > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(power)) : FLOOR_DB)

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
  return sorted[index]!
}

/** Mean of each value and its `radius` neighbours either side. */
function movingAverage(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length)
  const prefix = new Float64Array(values.length + 1)
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i]! + values[i]!
  for (let i = 0; i < values.length; i++) {
    const low = Math.max(0, i - radius)
    const high = Math.min(values.length, i + radius + 1)
    out[i] = (prefix[high]! - prefix[low]!) / (high - low)
  }
  return out
}

export class SonicAnalyzer {
  private readonly fft = new RealFft(FRAME)
  private readonly window = new Float64Array(FRAME)
  private readonly windowPower: number
  private readonly frame = new Float64Array(FRAME)
  private readonly power = new Float64Array(FRAME / 2 + 1)
  private readonly mel = melFilters()
  private readonly dct = dctMatrix()
  private readonly logMel = new Float64Array(MEL_BANDS)
  private readonly previousLogMel = new Float64Array(MEL_BANDS).fill(FLOOR_DB)
  private readonly mfcc = new Float64Array(MFCCS)
  private readonly pitch = new Float64Array(PITCH_BIN_COUNT)
  private pending = new Float32Array(0)
  private samples = 0
  private loudestLogMel = FLOOR_DB

  private readonly onsets = new Series()
  /** Frame power (mean square of the windowed frame, window-corrected). */
  private readonly levels = new Series()
  /** centroid Hz, flatness, rolloff Hz, zero crossings per sample. */
  private readonly spectral = new Series(4)
  private readonly cepstra = new Series(MFCCS)

  constructor() {
    let sum = 0
    for (let i = 0; i < FRAME; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
      sum += this.window[i]! * this.window[i]!
    }
    this.windowPower = sum / FRAME
  }

  /** Feeds the next samples (mono, `SAMPLE_RATE`, nominally −1..1). */
  push(chunk: Float32Array): void {
    this.samples += chunk.length
    const data = new Float32Array(this.pending.length + chunk.length)
    data.set(this.pending)
    data.set(chunk, this.pending.length)
    let offset = 0
    for (; offset + FRAME <= data.length; offset += HOP) this.analyzeFrame(data, offset)
    this.pending = data.slice(offset)
  }

  private analyzeFrame(data: Float32Array, offset: number) {
    const { frame, window, power } = this
    let crossings = 0
    let previous = data[offset]!
    let energy = 0
    for (let i = 0; i < FRAME; i++) {
      const sample = data[offset + i]!
      if ((sample >= 0) !== (previous >= 0)) crossings++
      previous = sample
      frame[i] = sample * window[i]!
      energy += frame[i]! * frame[i]!
    }
    this.levels.push([energy / FRAME / this.windowPower])
    this.fft.power(frame, power)

    const binHz = SAMPLE_RATE / FRAME
    let total = 0
    let weighted = 0
    let logSum = 0
    let loudest = 0
    for (let k = 1; k < power.length; k++) {
      const value = power[k]!
      total += value
      weighted += value * k * binHz
      logSum += Math.log(value + 1e-12)
      if (value > loudest) loudest = value
    }
    const bins = power.length - 1
    const flatness = total > 0 ? Math.exp(logSum / bins) / (total / bins) : 0
    let rolloff = 0
    for (let k = 1, running = 0; k < power.length; k++) {
      running += power[k]!
      if (running >= 0.85 * total) {
        rolloff = k * binHz
        break
      }
    }
    this.spectral.push([total > 0 ? weighted / total : 0, flatness, rolloff, crossings / FRAME])

    let flux = 0
    for (let band = 0; band < MEL_BANDS; band++) {
      const { start, weights } = this.mel[band]!
      let sum = 0
      for (let i = 0; i < weights.length; i++) sum += weights[i]! * power[start + i]!
      const db = toDb(sum)
      if (db > this.loudestLogMel) this.loudestLogMel = db
      // Like librosa, only the top 80 dB count, so noise in silence makes no onsets.
      this.logMel[band] = Math.max(db, this.loudestLogMel - 80)
      flux += Math.max(0, this.logMel[band]! - this.previousLogMel[band]!)
    }
    // The first frame has nothing to change from.
    this.onsets.push([this.levels.length === 1 ? 0 : flux / MEL_BANDS])
    this.previousLogMel.set(this.logMel)
    for (let i = 0; i < MFCCS; i++) {
      let sum = 0
      for (let j = 0; j < MEL_BANDS; j++) sum += this.dct[i * MEL_BANDS + j]! * this.logMel[j]!
      this.mfcc[i] = sum
    }
    this.cepstra.push(this.mfcc)

    this.addPeaks(loudest, Math.sqrt(energy / FRAME))
  }

  /** Adds the frame's spectral peaks to the pitch histogram, weighted by the frame's level. */
  private addPeaks(loudest: number, level: number) {
    if (loudest <= 0 || level <= 0) return
    const { power } = this
    const binHz = SAMPLE_RATE / FRAME
    const floor = loudest * 10 ** (-PEAK_FLOOR_DB / 10)
    const first = Math.max(2, Math.floor(PEAK_MIN_HZ / binHz))
    const last = Math.min(power.length - 2, Math.ceil(PEAK_MAX_HZ / binHz))
    let frameTotal = 0
    const found: [number, number][] = []
    for (let k = first; k <= last; k++) {
      const value = power[k]!
      if (value < floor || value <= power[k - 1]! || value < power[k + 1]!) continue
      // Parabolic interpolation on the dB values places the peak between bins.
      const a = toDb(power[k - 1]!)
      const b = toDb(value)
      const c = toDb(power[k + 1]!)
      const denominator = a - 2 * b + c
      const shift = denominator < 0 ? (0.5 * (a - c)) / denominator : 0
      const hz = (k + shift) * binHz
      const magnitude = Math.sqrt(value)
      found.push([hz, magnitude])
      frameTotal += magnitude
    }
    if (frameTotal <= 0) return
    for (const [hz, magnitude] of found) {
      // Cents above C, in one octave.
      const cents = (((1200 * Math.log2(hz / 440) + 900) % 1200) + 1200) % 1200
      this.pitch[Math.floor(cents / 10) % PITCH_BIN_COUNT]! += (magnitude / frameTotal) * level
    }
  }

  /** The features of everything pushed so far; null when nothing was. */
  finish(): SonicFeatures | null {
    const frames = this.levels.length
    if (frames === 0) return null
    const analyzedMs = Math.round((this.samples / SAMPLE_RATE) * 1000)
    // A frame stands for the moment at its centre.
    const frameMs = (index: number) => Math.min(analyzedMs, Math.round(((index * HOP + FRAME / 2) / SAMPLE_RATE) * 1000))
    const averaged = movingAverage(this.levels.values(), Math.round((LEVEL_SMOOTH_SECONDS * FPS) / 2))
    const smoothed = averaged.map(toDb)

    const sortedLevels = [...smoothed].sort((a, b) => a - b)
    // The typical level: the median of the frames not drowned in silence.
    const loudish = sortedLevels.filter((db) => db > FLOOR_DB + 1)
    const body = loudish.length ? percentile(loudish, 0.5) : FLOOR_DB
    const audible = (index: number) => smoothed[index]! >= body - AUDIBLE_DB && smoothed[index]! > FLOOR_DB + 1
    let first = -1
    let last = -1
    for (let i = 0; i < frames; i++) {
      if (!audible(i)) continue
      if (first < 0) first = i
      last = i
    }
    const tempo = estimateTempo(this.onsets.values(), FPS)
    const key = estimateKey(this.pitch)
    if (first < 0) {
      return {
        analyzedMs, bpm: null, bpmConfidence: 0, beatOffsetMs: null, key: null, mode: null, keyStrength: 0, tuningCents: null,
        levelDb: null, dynamicRangeDb: null, onsetRate: 0, centroidHz: null, energy: null, danceability: null,
        audibleStartMs: null, audibleEndMs: null, introEndMs: null, outroStartMs: null, vector: null,
      }
    }

    let introEnd = first
    while (introEnd < last && smoothed[introEnd]! < body - BODY_DB) introEnd++
    let outroStart = last
    while (outroStart > introEnd && smoothed[outroStart]! < body - BODY_DB) outroStart--

    // Audible-frame statistics.
    let powerSum = 0
    let count = 0
    const mfccSum = new Float64Array(MFCCS)
    const mfccSquares = new Float64Array(MFCCS)
    let logCentroidSum = 0
    let logCentroidSquares = 0
    let centroidSum = 0
    let flatnessSum = 0
    let logRolloffSum = 0
    let crossingSum = 0
    for (let i = first; i <= last; i++) {
      if (!audible(i)) continue
      count++
      powerSum += this.levels.get(i)
      for (let c = 1; c < MFCCS; c++) {
        const value = this.cepstra.get(i, c)
        mfccSum[c]! += value
        mfccSquares[c]! += value * value
      }
      const centroid = Math.max(20, this.spectral.get(i, 0))
      centroidSum += centroid
      logCentroidSum += Math.log2(centroid)
      logCentroidSquares += Math.log2(centroid) ** 2
      flatnessSum += this.spectral.get(i, 1)
      logRolloffSum += Math.log2(Math.max(20, this.spectral.get(i, 2)))
      crossingSum += this.spectral.get(i, 3)
    }
    const mean = (sum: number) => sum / count
    const std = (sum: number, squares: number) => Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2))
    const levelDb = toDb(powerSum / count)

    // Loudness range: three-second levels of the audible part.
    const windowFrames = Math.max(1, Math.round(DYNAMICS_WINDOW_SECONDS * FPS))
    const windowLevels: number[] = []
    for (let start = first; start + windowFrames <= last + 1; start += Math.round(windowFrames / 3)) {
      let sum = 0
      for (let i = start; i < start + windowFrames; i++) sum += this.levels.get(i)
      const db = toDb(sum / windowFrames)
      if (db >= body - AUDIBLE_DB) windowLevels.push(db)
    }
    windowLevels.sort((a, b) => a - b)
    const dynamicRangeDb = windowLevels.length >= 2 ? percentile(windowLevels, 0.95) - percentile(windowLevels, 0.1) : 0

    const audibleSeconds = ((last - first + 1) * HOP) / SAMPLE_RATE
    const onsetRate = countOnsets(this.onsets.values(), first, last) / Math.max(1, audibleSeconds)
    const centroidHz = mean(centroidSum)

    const bpm = tempo?.bpm ?? null
    const bpmConfidence = tempo ? clamp01(tempo.clarity / 0.5) : 0
    // Frame t's flux reacts to audio around the end of its window.
    const beatOffsetMs = tempo ? Math.round((((tempo.phaseFrames * HOP) + FRAME * 0.75) / SAMPLE_RATE) * 1000) % Math.round(60000 / tempo.bpm) : null
    const keyStrength = key?.strength ?? 0
    const energy = clamp01(0.5 * scale(levelDb, -40, -8) + 0.25 * scale(onsetRate, 0.5, 8) + 0.25 * scale(Math.log2(centroidHz), Math.log2(400), Math.log2(3500)))
    const danceTempo = bpm ? Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.35) ** 2) : 0
    const danceability = clamp01(bpmConfidence * (0.4 + 0.6 * danceTempo))

    const vector = [
      ...Array.from({ length: MFCCS - 1 }, (_, i) => mean(mfccSum[i + 1]!)),
      ...Array.from({ length: MFCCS - 1 }, (_, i) => std(mfccSum[i + 1]!, mfccSquares[i + 1]!)),
      mean(logCentroidSum), std(logCentroidSum, logCentroidSquares), mean(flatnessSum), mean(logRolloffSum), mean(crossingSum),
      onsetRate, dynamicRangeDb, tempo?.clarity ?? 0, keyStrength, levelDb,
    ]

    return {
      analyzedMs,
      bpm: bpm === null ? null : Math.round(bpm * 100) / 100,
      bpmConfidence,
      beatOffsetMs,
      key: key?.key ?? null,
      mode: key?.mode ?? null,
      keyStrength,
      tuningCents: key?.tuningCents ?? null,
      levelDb,
      dynamicRangeDb,
      onsetRate,
      centroidHz,
      energy,
      danceability,
      audibleStartMs: frameMs(first),
      audibleEndMs: frameMs(last),
      introEndMs: frameMs(introEnd),
      outroStartMs: frameMs(outroStart),
      vector,
    }
  }
}

/** Peaks of the onset envelope that stand out from their surroundings (half a second either way). */
function countOnsets(envelope: Float32Array, first: number, last: number): number {
  const local = movingAverage(envelope, Math.round(FPS / 2))
  let mean = 0
  for (let i = first; i <= last; i++) mean += envelope[i]!
  mean /= Math.max(1, last - first + 1)
  let count = 0
  for (let i = Math.max(1, first); i < Math.min(envelope.length - 1, last); i++) {
    const value = envelope[i]!
    if (value > envelope[i - 1]! && value >= envelope[i + 1]! && value > 1.5 * local[i]! && value > 0.5 * mean) count++
  }
  return count
}
