/**
 * How the seeds sound, for ranking (from the sonic module's analysis).
 *
 * - Similarity is by rank, not by raw distance: a candidate's `sonic` feature is
 *   (1 − p)², where p is the share of the library nearer the seeds (their averaged vector,
 *   recent seeds weighing more) than it is: 1 for the nearest track, 0.25 at the median, 0
 *   for the farthest. Rank needs no calibration, whatever the library holds or how big it is.
 * - The nearest few percent of the library (at most `NEIGHBOURS`) are also gathered as a
 *   pool and count as related, so a library with sparse genres and no similar-artist
 *   sources (Deezer off) still has a radio that holds together.
 * - `transitionCost` is what moving from one track to the next costs in a sequence: a
 *   tempo jump (double and half time count as the same tempo), a key that clashes on the
 *   Camelot wheel, a jump in energy. Each applies only when both tracks are known well
 *   enough, so unanalysed tracks are neither helped nor hurt.
 */
import { centroid, distance, keyDistance, neighbourhood, sonicIndex, vectorOf, type Neighbourhood, type SonicIndex, type SonicPoint } from '../sonic/index.js'

export type SeedSound = {
  index: SonicIndex
  /** The seeds' averaged vector; null when none of them is analysed. */
  query: Float32Array | null
  near: Neighbourhood | null
  /** The recordings nearest the seeds: a pool, and related. */
  neighbours: Set<string>
}

/** Most neighbours gathered (and counted related); fewer in a small library. */
const NEIGHBOURS = 40
/** The neighbours' share of the library: a radio's related tracks should be the close ones. */
const NEIGHBOUR_SHARE = 0.05
/** The sonic radio gathers more of them and lets fewer of them count. */
const SOUND_NEIGHBOURS = 120
const SOUND_NEIGHBOUR_SHARE = 0.1

/** Tempo, as a fraction of an octave, that still mixes without notice (about 3%). */
const TEMPO_FREE = Math.log2(1.03)
/** Where a tempo jump costs fully (about 15%). */
const TEMPO_FULL = Math.log2(1.15)
const MIN_BPM_CONFIDENCE = 0.3
const MIN_KEY_CONFIDENCE = 0.5
/** An energy change within this is free; one of `ENERGY_FULL` more costs fully. */
const ENERGY_FREE = 0.15
const ENERGY_FULL = 0.35

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export async function seedSound(seeds: readonly string[], exclude: ReadonlySet<string>, sound: boolean): Promise<SeedSound> {
  const index = await sonicIndex()
  const vectors = seeds.flatMap((id, position) => {
    const vector = vectorOf(index, id)
    return vector ? [{ vector, weight: 0.5 + (0.5 * (position + 1)) / seeds.length }] : []
  })
  const query = centroid(vectors)
  if (!query) return { index, query: null, near: null, neighbours: new Set() }
  const share = sound ? SOUND_NEIGHBOUR_SHARE : NEIGHBOUR_SHARE
  const limit = Math.min(sound ? SOUND_NEIGHBOURS : NEIGHBOURS, Math.max(3, Math.round(index.ids.length * share)))
  const near = neighbourhood(index, query, limit, exclude)
  return { index, query, near, neighbours: new Set(near.nearest.map((one) => one.id)) }
}

/** 0..1, how close the recording sounds to the seeds by rank in the library; null when not analysed. */
export function similarity(sound: SeedSound, recordingId: string): number | null {
  if (!sound.query || !sound.near) return null
  const vector = vectorOf(sound.index, recordingId)
  if (!vector) return null
  return (1 - sound.near.percentile(distance(sound.query, vector))) ** 2
}

export type TransitionWeights = { tempoJump: number; keyClash: number; energyJump: number }

/** What following `from` with `to` costs, as a non-negative amount to take off `to`'s score. */
export function transitionCost(from: SonicPoint | undefined, to: SonicPoint | undefined, weights: TransitionWeights): number {
  if (!from || !to) return 0
  let cost = 0
  if (from.bpm && to.bpm && Math.min(from.bpmConfidence, to.bpmConfidence) >= MIN_BPM_CONFIDENCE) {
    const octaves = Math.log2(to.bpm / from.bpm)
    const off = Math.abs(octaves - Math.round(octaves))
    cost += Math.abs(weights.tempoJump) * clamp01((off - TEMPO_FREE) / (TEMPO_FULL - TEMPO_FREE))
  }
  if (from.key && to.key && Math.min(from.keyConfidence, to.keyConfidence) >= MIN_KEY_CONFIDENCE) {
    const steps = keyDistance(from.key, to.key)
    cost += Math.abs(weights.keyClash) * (steps <= 1 ? 0 : steps === 2 ? 0.5 : 1)
  }
  if (from.energy !== null && to.energy !== null) {
    cost += Math.abs(weights.energyJump) * clamp01((Math.abs(to.energy - from.energy) - ENERGY_FREE) / ENERGY_FULL)
  }
  return cost
}

/**
 * Seam for how alike artists sound, for the mixes (mixes.ts `affinity`): for pairs of the
 * given artists, a similarity from 0 (nothing alike) to 1 (alike), keyed by `pairKey`; a pair
 * it cannot judge is left out. It answers null for now, so mixes are made from the genre,
 * similar-artist and co-listening signals alone; the sonic index above is what fills it in.
 */
export async function artistSoundAffinity(artistIds: readonly string[]): Promise<Map<string, number> | null> {
  void artistIds
  return null
}

/** The key of an unordered pair of ids. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
