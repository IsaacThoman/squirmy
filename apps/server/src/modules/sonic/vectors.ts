/**
 * The library's timbre vectors in memory, for similarity.
 *
 * Each analysed recording has one raw vector (`VECTOR_LAYOUT`, from its best analysed
 * file). Here every element is standardized over the library (mean 0, deviation 1) and
 * weighted by its group, so a distance means the same whatever the units, and the groups
 * count as `GROUP_SHARES` says rather than by how many elements they have. Two tracks
 * drawn at random are then about √2 apart.
 *
 * Search is brute force: a home library of 100,000 analysed tracks is 13 MB of floats and
 * a few milliseconds per query, so no vector index (pgvector) is needed and any Postgres
 * works. The index is rebuilt when analyses change: checked at most every `CHECK_MS`,
 * rebuilt at most every `REBUILD_MS` while analysis is still running through a library
 * (always at once while it is small).
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { VECTOR_LAYOUT, VECTOR_LENGTH } from './dsp/analyzer.js'

/** How much each group of descriptors counts in a distance; they add up to 1. */
const GROUP_SHARES: Record<string, number> = {
  timbre: 0.35,
  timbreMotion: 0.15,
  spectrum: 0.25,
  rhythm: 0.15,
  dynamics: 0.07,
  tonality: 0.03,
}

function groupOf(name: (typeof VECTOR_LAYOUT)[number]): keyof typeof GROUP_SHARES {
  if (/^mfcc\d+Mean$/.test(name)) return 'timbre'
  if (/^mfcc\d+Std$/.test(name)) return 'timbreMotion'
  if (name === 'onsetRate' || name === 'pulseClarity') return 'rhythm'
  if (name === 'dynamicRange' || name === 'level') return 'dynamics'
  if (name === 'keyStrength') return 'tonality'
  return 'spectrum'
}

const WEIGHTS = (() => {
  const counts = new Map<string, number>()
  for (const name of VECTOR_LAYOUT) counts.set(groupOf(name), (counts.get(groupOf(name)) ?? 0) + 1)
  return Float64Array.from(VECTOR_LAYOUT, (name) => Math.sqrt(GROUP_SHARES[groupOf(name)]! / counts.get(groupOf(name))!))
})()

/**
 * The vector length, read once: an imported binding read in the distance loop costs a
 * getter call per element under the test runner's module loader.
 */
const WIDTH = VECTOR_LENGTH
const CHECK_MS = 60_000
const REBUILD_MS = 5 * 60_000
/** Below this many vectors a rebuild costs nothing, so the index follows every change. */
const SMALL_INDEX = 500

export type SonicIndex = {
  /** Recording ids, in row order. */
  ids: string[]
  rows: Map<string, number>
  /** Standardized, weighted vectors, `VECTOR_LENGTH` per row. */
  data: Float32Array
  mean: Float64Array
  deviation: Float64Array
}

type State = { index: SonicIndex; signature: string; checkedAt: number; builtAt: number }
let state: State | null = null
let pending: Promise<SonicIndex> | null = null

/** The analysed files' vectors that stand for a present recording: one per recording. */
async function loadVectors(): Promise<{ id: string; vector: number[] }[]> {
  return db.execute<{ id: string; vector: number[] }>(sql`
    select distinct on (f.recording_id) f.recording_id as id, s.vector
    from sonic_analyses s join media_files f on f.id = s.file_id
    where f.missing_since is null and f.recording_id is not null and s.vector is not null and s.error is null
      and cardinality(s.vector) = ${WIDTH}
    order by f.recording_id, f.lossless desc, s.analyzed_at desc, f.id`)
}

async function signature(): Promise<string> {
  const [row] = await db.execute<{ count: number; latest: string | null }>(sql`
    select count(*)::int as count, max(s.analyzed_at)::text as latest
    from sonic_analyses s join media_files f on f.id = s.file_id
    where f.missing_since is null and f.recording_id is not null and s.vector is not null and s.error is null`)
  return `${row?.count ?? 0}:${row?.latest ?? ''}`
}

/** Standardizes raw vectors over the set and weights each element by its group. */
export function buildIndex(rows: readonly { id: string; vector: readonly number[] }[]): SonicIndex {
  const width = WIDTH
  const mean = new Float64Array(width)
  const deviation = new Float64Array(width)
  for (const row of rows) for (let d = 0; d < width; d++) mean[d]! += row.vector[d]! / rows.length
  for (const row of rows) for (let d = 0; d < width; d++) deviation[d]! += (row.vector[d]! - mean[d]!) ** 2 / rows.length
  for (let d = 0; d < width; d++) deviation[d] = Math.sqrt(deviation[d]!)
  const data = new Float32Array(rows.length * width)
  rows.forEach((row, index) => data.set(standardize(row.vector, mean, deviation), index * width))
  return { ids: rows.map((row) => row.id), rows: new Map(rows.map((row, index) => [row.id, index])), data, mean, deviation }
}

function standardize(vector: readonly number[], mean: Float64Array, deviation: Float64Array): Float32Array {
  // An element that does not vary in the library says nothing about similarity.
  return Float32Array.from({ length: WIDTH }, (_, d) => (deviation[d]! > 1e-9 ? ((vector[d]! - mean[d]!) / deviation[d]!) * WEIGHTS[d]! : 0))
}

/** The current index; rebuilt as described at the top of this file. */
export async function sonicIndex(): Promise<SonicIndex> {
  const now = Date.now()
  if (state && now - state.checkedAt < CHECK_MS && state.index.ids.length >= SMALL_INDEX) return state.index
  pending ??= (async () => {
    try {
      const current = await signature()
      if (state && current === state.signature) {
        state.checkedAt = Date.now()
        return state.index
      }
      if (state && state.index.ids.length >= SMALL_INDEX && Date.now() - state.builtAt < REBUILD_MS) {
        state.checkedAt = Date.now()
        return state.index
      }
      const index = buildIndex(await loadVectors())
      state = { index, signature: current, checkedAt: Date.now(), builtAt: Date.now() }
      return index
    } finally {
      pending = null
    }
  })()
  return pending
}

/** Forgets the index, so the next call rebuilds it (tests). */
export function resetSonicIndex() {
  state = null
}

/** The recording's standardized vector, if it is analysed. */
export function vectorOf(index: SonicIndex, recordingId: string): Float32Array | null {
  const row = index.rows.get(recordingId)
  return row === undefined ? null : index.data.subarray(row * WIDTH, (row + 1) * WIDTH)
}

/** Weighted mean of standardized vectors; null when there are none. */
export function centroid(vectors: readonly { vector: Float32Array; weight: number }[]): Float32Array | null {
  const total = vectors.reduce((sum, one) => sum + one.weight, 0)
  if (vectors.length === 0 || total <= 0) return null
  const out = new Float32Array(WIDTH)
  for (const { vector, weight } of vectors) for (let d = 0; d < WIDTH; d++) out[d]! += (vector[d]! * weight) / total
  return out
}

export function distance(a: Float32Array, b: Float32Array, bOffset = 0): number {
  let sum = 0
  for (let d = 0; d < WIDTH; d++) {
    const delta = a[d]! - b[bOffset + d]!
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

export type Neighbourhood = {
  /** The nearest recordings, closest first, without the excluded ones. */
  nearest: { id: string; distance: number }[]
  /** 0 for the nearest recording in the library, 1 for the farthest. */
  percentile: (distance: number) => number
}

/** Bins of the distance histogram percentiles are read from: finer than ranking can tell apart. */
const PERCENTILE_BINS = 1024

/**
 * Distances from `query` to the whole library, with the `limit` nearest not in `exclude`.
 * Percentiles come from a histogram of the distances rather than sorting them, which
 * would cost more than the distances themselves in a large library.
 */
export function neighbourhood(index: SonicIndex, query: Float32Array, limit: number, exclude: ReadonlySet<string> = new Set()): Neighbourhood {
  const count = index.ids.length
  const distances = new Float64Array(count)
  let low = Infinity
  let high = -Infinity
  for (let row = 0; row < count; row++) {
    const value = distance(query, index.data, row * WIDTH)
    distances[row] = value
    if (value < low) low = value
    if (value > high) high = value
  }
  const nearest: { id: string; distance: number }[] = []
  for (let row = 0; row < count; row++) {
    const id = index.ids[row]!
    const value = distances[row]!
    if (exclude.has(id) || (nearest.length >= limit && value >= nearest.at(-1)!.distance)) continue
    let at = nearest.length
    while (at > 0 && nearest[at - 1]!.distance > value) at--
    nearest.splice(at, 0, { id, distance: value })
    if (nearest.length > limit) nearest.pop()
  }
  const width = high > low ? (high - low) / PERCENTILE_BINS : 1
  const below = new Float64Array(PERCENTILE_BINS + 1)
  for (const value of distances) below[Math.min(PERCENTILE_BINS - 1, Math.floor((value - low) / width)) + 1]! += 1
  for (let bin = 1; bin <= PERCENTILE_BINS; bin++) below[bin]! += below[bin - 1]!
  const percentile = (value: number) => {
    if (count <= 1 || value <= low) return 0
    if (value >= high) return 1
    const position = (value - low) / width
    const bin = Math.floor(position)
    // Within a bin, assume its distances are spread evenly.
    const rank = below[bin]! + (below[bin + 1]! - below[bin]!) * (position - bin)
    return Math.min(1, rank / (count - 1))
  }
  return { nearest, percentile }
}
