/**
 * Key and mode from a pitch-class histogram (the Krumhansl–Schmuckler method).
 *
 * The analyzer accumulates spectral peaks into 120 bins of 10 cents over one octave,
 * starting at C. The tuning offset is the circular mean of where peaks sit within a
 * semitone, so a recording tuned a little sharp or flat still folds onto the right
 * pitch classes. The folded 12-bin chroma is then correlated with the Krumhansl–Kessler
 * major and minor profiles in every rotation; the best correlation is the key, and the
 * correlation itself (0..1) its strength.
 */

export const PITCH_BINS = 120
const BINS_PER_SEMITONE = PITCH_BINS / 12

/** Krumhansl & Kessler (1982) probe-tone ratings, tonic first. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export type Mode = 'major' | 'minor'
export type KeyEstimate = { key: number; mode: Mode; strength: number; tuningCents: number; chroma: number[] }

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length
  const meanA = a.reduce((sum, value) => sum + value, 0) / n
  const meanB = b.reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - meanA
    const y = b[i]! - meanB
    numerator += x * y
    varA += x * x
    varB += y * y
  }
  return varA > 0 && varB > 0 ? numerator / Math.sqrt(varA * varB) : 0
}

/** Folds the 10-cent histogram into 12 pitch classes, corrected for tuning. */
export function foldChroma(histogram: Float64Array): { chroma: number[]; tuningCents: number } {
  let x = 0
  let y = 0
  for (let bin = 0; bin < PITCH_BINS; bin++) {
    const within = ((bin + 0.5) % BINS_PER_SEMITONE) / BINS_PER_SEMITONE
    x += histogram[bin]! * Math.cos(2 * Math.PI * within)
    y += histogram[bin]! * Math.sin(2 * Math.PI * within)
  }
  // A bin's centre sits half a bin above its pitch class when perfectly in tune.
  const tuning = x === 0 && y === 0 ? 0 : Math.atan2(y, x) / (2 * Math.PI)
  const chroma = new Array<number>(12).fill(0)
  for (let bin = 0; bin < PITCH_BINS; bin++) {
    const semitones = (bin + 0.5) / BINS_PER_SEMITONE - tuning
    const nearest = Math.round(semitones)
    const distance = semitones - nearest
    const weight = Math.cos(Math.PI * distance) ** 2
    chroma[((nearest % 12) + 12) % 12]! += histogram[bin]! * weight
  }
  const total = chroma.reduce((sum, value) => sum + value, 0)
  return { chroma: total > 0 ? chroma.map((value) => value / total) : chroma, tuningCents: Math.round(tuning * 100) }
}

export function estimateKey(histogram: Float64Array): KeyEstimate | null {
  const { chroma, tuningCents } = foldChroma(histogram)
  if (chroma.every((value) => value === 0)) return null
  let best: KeyEstimate | null = null
  for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
    for (let key = 0; key < 12; key++) {
      const rotated = chroma.map((_, pitch) => chroma[(pitch + key) % 12]!)
      const r = correlation(rotated, profile)
      if (!best || r > best.strength) best = { key, mode, strength: r, tuningCents, chroma }
    }
  }
  return best && best.strength > 0 ? { ...best, strength: Math.min(1, best.strength) } : null
}
