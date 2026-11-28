import { sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { explicitAllowed, recordingExplicit } from '../../catalog/explicit.js'
import { uuidArray } from '../../catalog/sql.js'
import { centroid, distance, neighbourhood, sonicIndex, sonicNeighbours, vectorOf, type SonicIndex } from '../../sonic/index.js'
import { expectId, trackId } from '../ids.js'
import { invalidParameter, notFound, Params, type Context, type Handler } from '../protocol.js'
import { songs } from '../songs.js'
import { libraryRecording } from '../sql.js'
import { resolve, similarSongs } from './browsing.js'

async function excludedFromLibrary(userId: string, candidates: readonly string[]): Promise<string[]> {
  if (!candidates.length) return []
  const allowed = await explicitAllowed(userId)
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from recordings r
    where r.id = any(${uuidArray(candidates)}) and r.merged_into_id is null
      and ${libraryRecording('r.id', userId)}
      ${allowed ? sql`` : sql`and not ${recordingExplicit(sql`r.id`, sql`r.explicit`)}`}`)
  const visible = new Set(rows.map((row) => row.id))
  return candidates.filter((id) => !visible.has(id))
}

async function getSonicSimilarTracks(context: Context) {
  const { params, user } = context
  const id = await resolve('track', expectId(params.required('id'), 'track').id)
  const count = params.int('count', 10, { min: 0, max: 500 })
  if (!(await songs(user.id, [{ id }])).length) throw notFound('Song')
  if (count === 0) return { sonicMatch: [] }

  const index = await sonicIndex()
  if (!vectorOf(index, id)) {
    const entries = await similarSongs({ ...context, params: Params.from({ id: trackId(id), count: String(count) }) })
    // The radio can rank related tracks without measuring an audio similarity.
    return { sonicMatch: entries.map((entry) => ({ entry, similarity: -1 })) }
  }

  const exclude = await excludedFromLibrary(user.id, index.ids)
  const similar = await sonicNeighbours([id], { limit: count, exclude })
  const scores = new Map(similar.map(({ id, similarity }) => [trackId(id), similarity]))
  const entries = await songs(user.id, similar)
  return { sonicMatch: entries.map((entry) => ({ entry, similarity: scores.get(String(entry.id))! })) }
}

/**
 * Split the largest jumps with recordings that sound closer to both sides. Require
 * progress toward the endpoint in timbre space so the path cannot loop or double back.
 */
function routeBetween(index: SonicIndex, start: string, end: string, count: number, exclude: readonly string[]): string[] {
  const first = vectorOf(index, start)!
  const last = vectorOf(index, end)!
  const midpoint = centroid([{ vector: first, weight: 1 }, { vector: last, weight: 1 }])!
  const candidates = neighbourhood(index, midpoint, Math.max(64, count * 2), new Set([...exclude, start, end])).nearest
    .map(({ id }) => {
      const vector = vectorOf(index, id)!
      return { id, vector, remaining: distance(vector, last) }
    })
  const route = [{ id: start, vector: first, remaining: distance(first, last) }, { id: end, vector: last, remaining: 0 }]
  while (route.length < count) {
    let gap = 0
    let at = 0
    let bridge: (typeof candidates)[number] | undefined
    for (let i = 1; i < route.length; i++) {
      const before = route[i - 1]!
      const after = route[i]!
      const jump = distance(before.vector, after.vector)
      if (jump <= gap) continue
      let best = jump
      for (const candidate of candidates) {
        if (candidate.remaining >= before.remaining || candidate.remaining <= after.remaining) continue
        const step = Math.max(distance(before.vector, candidate.vector), distance(candidate.vector, after.vector))
        if (step >= best) continue
        best = step
        at = i
        gap = jump
        bridge = candidate
      }
    }
    if (!bridge) break
    route.splice(at, 0, bridge)
  }
  return route.map(({ id }) => id)
}

async function findSonicPath(context: Context) {
  const { params, user } = context
  const [start, end] = await Promise.all([
    resolve('track', expectId(params.required('startSongId'), 'track').id),
    resolve('track', expectId(params.required('endSongId'), 'track').id),
  ])
  const count = params.int('count', 25, { min: 1, max: 100 })
  if (start !== end && count < 2) throw invalidParameter('count')
  const endpoints = await songs(user.id, [{ id: start }, { id: end }])
  if (endpoints.length !== 2) throw notFound('Song')
  if (start === end) return { sonicMatch: [{ entry: endpoints[0], similarity: 1 }] }

  const index = await sonicIndex()
  const first = vectorOf(index, start)
  const last = vectorOf(index, end)
  if (!first || !last) {
    const related = count > 2 ? await similarSongs({ ...context, params: Params.from({ id: trackId(start), count: String(count - 1) }) }) : []
    const entries = related.filter((entry) => entry.id !== trackId(start) && entry.id !== trackId(end)).slice(0, count - 2)
    return { sonicMatch: [
      { entry: endpoints[0], similarity: 1 },
      ...entries.map((entry) => ({ entry, similarity: -1 })),
      { entry: endpoints[1], similarity: -1 },
    ] }
  }

  const exclude = await excludedFromLibrary(user.id, index.ids)
  const route = routeBetween(index, start, end, count, exclude)
  const near = neighbourhood(index, first, 1)
  const scores = new Map(route.map((id) => [trackId(id), 1 - near.percentile(distance(first, vectorOf(index, id)!))]))
  const waypoints = await songs(user.id, route.slice(1, -1).map((id) => ({ id })))
  return { sonicMatch: [endpoints[0]!, ...waypoints, endpoints[1]!].map((entry) => ({ entry, similarity: scores.get(String(entry.id))! })) }
}

export const sonicEndpoints: Record<string, Handler> = { getSonicSimilarTracks, findSonicPath }
