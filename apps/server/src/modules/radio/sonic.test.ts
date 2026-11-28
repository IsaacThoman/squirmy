import { RadioResponse } from '@squirmy/contracts'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, mediaFiles, sonicAnalyses } from '../../database/schema.js'
import { getQueueStats, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { VECTOR_LENGTH } from '../sonic/dsp/analyzer.js'
import type { SonicPoint } from '../sonic/index.js'
import { resetSonicIndex } from '../sonic/vectors.js'
import { FILL_UP_TO, suggest, weights } from './ranking.js'
import { transitionCost } from './sonic.js'

vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async () => new Set<string>()),
  requestRecording: vi.fn(async () => {}),
}))

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const point = (overrides: Partial<SonicPoint>): SonicPoint => ({
  recordingId: 'x', analyzed: true, bpm: 120, bpmSource: 'analysis', bpmConfidence: 0.9,
  key: { tonic: 0, mode: 'major' }, keySource: 'analysis', keyConfidence: 0.9, energy: 0.5, danceability: 0.5, moods: [], ...overrides,
})

describe('transition cost', () => {
  const from = point({})
  it('is free for a close tempo, a compatible key and a similar energy', () => {
    expect(transitionCost(from, point({ bpm: 122, key: { tonic: 7, mode: 'major' }, energy: 0.6 }), weights)).toBe(0)
    expect(transitionCost(from, point({ bpm: 240, key: { tonic: 9, mode: 'minor' } }), weights)).toBe(0)
  })
  it('charges a tempo jump, a clashing key and an energy jump', () => {
    expect(transitionCost(from, point({ bpm: 150 }), weights)).toBeCloseTo(Math.abs(weights.tempoJump))
    expect(transitionCost(from, point({ key: { tonic: 6, mode: 'major' } }), weights)).toBeCloseTo(Math.abs(weights.keyClash))
    expect(transitionCost(from, point({ key: { tonic: 2, mode: 'major' } }), weights)).toBeCloseTo(Math.abs(weights.keyClash) / 2)
    expect(transitionCost(from, point({ energy: 1 }), weights)).toBeCloseTo(Math.abs(weights.energyJump))
  })
  it('ignores what is unknown or uncertain', () => {
    expect(transitionCost(undefined, point({ bpm: 150 }), weights)).toBe(0)
    expect(transitionCost(from, point({ bpm: 150, bpmConfidence: 0.1, key: { tonic: 6, mode: 'major' }, keyConfidence: 0.2, energy: null }), weights)).toBe(0)
  })
})

describe('radio with sonic analysis', () => {
  useTestDatabase()
  let app: FastifyInstance
  let userId = ''
  let headers: Record<string, string>
  let seed = ''
  const near: string[] = []
  const far: string[] = []

  /** A vector `offset` away from the seed's, in every element. */
  const vector = (offset: number) => Array.from({ length: VECTOR_LENGTH }, (_, d) => (d % 3) + offset * (d % 2 ? 1 : -1))

  async function shelf(name: string, genre: string, offsets: number[], into?: string[]) {
    const artist = await createArtist({ name })
    const created = await createAlbum({ artist, owned: true, title: `${name} Album`, tracks: offsets.map((_, index) => ({ title: `${name} ${index + 1}` })) })
    await db.update(albums).set({ genres: [genre] }).where(eq(albums.id, created.albumId))
    for (const [index, track] of created.tracks.entries()) {
      await db.insert(sonicAnalyses).values({
        fileId: track.fileId!, version: 1, bpm: 120, bpmConfidence: 0.9, key: 0, mode: 'major', keyStrength: 0.8, energy: 0.5,
        vector: vector(offsets[index]!),
      })
      into?.push(track.recordingId)
    }
    return created
  }

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: false })
    seed = (await shelf('Seed', 'Ambient', [0])).tracks[0]!.recordingId
    // Nothing shares a genre or an artist with the seed: only sound relates them. Enough
    // albums that sound alike to fill a window one album at a time.
    for (let artist = 0; artist < 10; artist++) await shelf(`Near ${artist}`, `Near genre ${artist}`, [0.1 + artist * 0.05, 0.7 + artist * 0.05], near)
    for (let artist = 0; artist < 6; artist++) await shelf(`Far ${artist}`, `Far genre ${artist}`, [4 + artist, 4.5 + artist], far)
    resetSonicIndex()
    await startJobs({ work: false })
    app = await buildApp()
    const user = await signIn()
    userId = user.id
    headers = user.headers
  })
  afterAll(async () => {
    await app?.close()
    await stopJobs()
  })

  it('counts the tracks that sound most like the seed as related', async () => {
    const picks = (await suggest({ userId, seeds: [seed], exclude: [], limit: 30 }, { random: seeded(1) })).map((one) => one.trackId)
    // The three nearest: the first track of the first three "Near" albums.
    const nearest = [near[0]!, near[2]!, near[4]!]
    expect(picks.slice(0, 3).toSorted()).toEqual(nearest.toSorted())
  })

  it('leans on sound much harder in a sonic radio', async () => {
    const count = (ids: string[], among: string[]) => ids.filter((id) => among.includes(id)).length
    let sonicFar = 0
    let ordinaryFar = 0
    for (let run = 0; run < 5; run++) {
      const sonic = (await suggest({ userId, seeds: [seed], exclude: [], limit: FILL_UP_TO, mode: 'sonic' }, { random: seeded(run) })).map((one) => one.trackId)
      const ordinary = (await suggest({ userId, seeds: [seed], exclude: [], limit: FILL_UP_TO }, { random: seeded(run) })).map((one) => one.trackId)
      sonicFar += count(sonic, far)
      ordinaryFar += count(ordinary, far)
      expect(count(sonic, near)).toBeGreaterThanOrEqual(count(ordinary, near))
    }
    expect(sonicFar).toBeLessThanOrEqual(2)
    expect(sonicFar).toBeLessThan(ordinaryFar)
  })

  it('starts a sonic radio from a track', async () => {
    const radio = body(await app.inject({ method: 'POST', url: `/api/v1/radio/sonic/${seed}`, headers }), RadioResponse)
    expect(radio.context).toMatchObject({ type: 'radio', id: `sonic:${seed}` })
    expect(radio.tracks[0]!.trackId).toBe(seed)
    expect(radio.tracks.length).toBeGreaterThan(1)
  })

  it('still plays a sonic radio from an unanalysed track, and queues its analysis', async () => {
    const [file] = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.recordingId, seed))
    await db.delete(sonicAnalyses).where(inArray(sonicAnalyses.fileId, [file!.id]))
    await db.update(mediaFiles).set({ probeStage: 2 }).where(eq(mediaFiles.id, file!.id))
    resetSonicIndex()
    const radio = body(await app.inject({ method: 'POST', url: `/api/v1/radio/sonic/${seed}`, headers }), RadioResponse)
    expect(radio.tracks[0]!.trackId).toBe(seed)
    expect((await getQueueStats()).find((queue) => queue.name === 'sonic.analyze')?.queued).toBe(1)
  })
})
