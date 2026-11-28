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
 * - `artistSoundAffinity` is how alike two artists sound, by the same rank, for the mixes.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
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

/** The share of the library nearer the seeds than the recording (0 nearest, 1 farthest); null when not analysed. */
export function soundRank(sound: SeedSound, recordingId: string): number | null {
  if (!sound.query || !sound.near) return null
  const vector = vectorOf(sound.index, recordingId)
  if (!vector) return null
  return sound.near.percentile(distance(sound.query, vector))
}

/** 0..1, how close the recording sounds to the seeds by rank in the library; null when not analysed. */
export function similarity(sound: SeedSound, recordingId: string): number | null {
  const rank = soundRank(sound, recordingId)
  return rank === null ? null : (1 - rank) ** 2
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

/** Fewest analysed tracks an artist needs for its sound to be judged. */
const MIN_ARTIST_TRACKS = 3
/** Most of an artist's analysed tracks its sound is measured from (the first by id: the same every day). */
const ARTIST_TRACKS = 200

/** The analysed recordings of each artist (credited on, or leading), in id order, in the index. */
async function artistTracks(index: SonicIndex, artistIds: readonly string[]): Promise<Map<string, Float32Array[]>> {
  const rows = await db.execute<{ artistId: string; id: string }>(sql`
    select r.primary_artist_id as "artistId", r.id from recordings r
    where r.primary_artist_id = any(${uuidArray(artistIds)}) and r.merged_into_id is null
    union
    select ra.artist_id, ra.recording_id from recording_artists ra join recordings r on r.id = ra.recording_id
    where ra.artist_id = any(${uuidArray(artistIds)}) and r.merged_into_id is null
    order by 1, 2`)
  const tracks = new Map<string, Float32Array[]>()
  for (const row of rows) {
    const vector = vectorOf(index, row.id)
    const list = tracks.get(row.artistId) ?? []
    if (!vector || list.length >= ARTIST_TRACKS) continue
    list.push(vector)
    tracks.set(row.artistId, list)
  }
  return tracks
}

/**
 * How alike artists sound, for the mixes (mixes.ts `affinity`): for pairs of the given
 * artists, a similarity from 0 (nothing alike) to 1 (alike), keyed by `pairKey`. An artist's
 * sound is the average of its analysed tracks' vectors. From A's sound, B's tracks are as
 * near as A's own on average (fully alike) or as far as the library's tracks are on average
 * (not at all), or between; the pair's similarity is the mean of both ways round. Measured
 * against the library's own spread, it needs no calibration: in a library of one genre, it
 * tells apart artists that a mixed library would call alike. An artist with fewer than
 * `MIN_ARTIST_TRACKS` analysed tracks is left out, as is every pair with it.
 */
export async function artistSoundAffinity(artistIds: readonly string[]): Promise<Map<string, number> | null> {
  const index = await sonicIndex()
  if (artistIds.length < 2 || index.ids.length < MIN_ARTIST_TRACKS * 2) return null
  const tracks = await artistTracks(index, artistIds)
  const width = index.data.length / index.ids.length
  const judged = artistIds.flatMap((id) => {
    const own = tracks.get(id) ?? []
    if (own.length < MIN_ARTIST_TRACKS) return []
    const sound = centroid(own.map((vector) => ({ vector, weight: 1 })))!
    let library = 0
    for (let row = 0; row < index.ids.length; row++) library += distance(sound, index.data, row * width)
    return [{ id, own, sound, far: library / index.ids.length }]
  })
  if (judged.length < 2) return null
  const near = (from: (typeof judged)[number], vectors: Float32Array[]) =>
    vectors.reduce((sum, vector) => sum + distance(from.sound, vector), 0) / vectors.length
  const ownNear = judged.map((one) => near(one, one.own))
  const pairs = new Map<string, number>()
  for (let a = 0; a < judged.length; a++) {
    for (let b = a + 1; b < judged.length; b++) {
      const way = (from: number, to: number) => {
        const spread = judged[from]!.far - ownNear[from]!
        return spread > 0 ? clamp01((judged[from]!.far - near(judged[from]!, judged[to]!.own)) / spread) : 0
      }
      pairs.set(pairKey(judged[a]!.id, judged[b]!.id), (way(a, b) + way(b, a)) / 2)
    }
  }
  return pairs
}

/** The key of an unordered pair of ids. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
