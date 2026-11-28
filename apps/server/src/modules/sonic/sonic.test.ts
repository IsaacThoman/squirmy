import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LibraryStats, TrackSonic } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { externalIds, mediaFiles, sonicAnalyses, sonicHints } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, signIn } from '../../test/api.js'
import { chords, makeBeatTrack } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { libraryModule } from '../library/index.js'
import { stopProgress } from '../library/progress.js'
import { insertRoot } from '../library/roots.js'
import { scanRoot } from '../library/scan.js'
import { loudnessModule } from '../loudness/index.js'
import { ANALYSIS_VERSION, analyzeFile } from './analyze.js'
import { sonicModule } from './index.js'
import { sonicNeighbours } from './profile.js'
import { sweepSonic } from './sweep.js'
import { resetSonicIndex } from './vectors.js'

describe('sonic analysis pipeline', () => {
  useTestDatabase()
  useHttpFixtures('sonic')
  let library = ''
  let rootId = ''
  let app: FastifyInstance
  let headers: Record<string, string>
  let adminHeaders: Record<string, string>

  const album = { artist: 'Beat Lab', album: 'Pulses' }
  const tracks = {
    fast: { path: 'Beat Lab/Pulses/01 Fast.flac', bpm: 128, chords: chords.cMajor, clickHz: 2500, tags: { title: 'Fast', track: 1 } },
    slow: { path: 'Beat Lab/Pulses/02 Slow.flac', bpm: 84, chords: chords.aMinor, clickHz: 400, tags: { title: 'Slow', track: 2 } },
    fastToo: { path: 'Beat Lab/Pulses/03 Fast Too.flac', bpm: 126, chords: chords.cMajor, clickHz: 2400, tags: { title: 'Fast Too', track: 3 } },
    // Tempo, key and mood as DJ software writes them, which win over the analysis.
    tagged: { path: 'Beat Lab/Pulses/04 Tagged.flac', bpm: 100, chords: chords.cMajor, tags: { title: 'Tagged', track: 4, BPM: 101, INITIALKEY: '8A', MOOD: 'Happy; Dreamy' } },
  }
  const fileOf = async (key: keyof typeof tracks) => {
    const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.rootId, rootId), eq(mediaFiles.relPath, tracks[key].path)))
    return file!
  }
  const analysisOf = async (key: keyof typeof tracks) => {
    const [row] = await db.select().from(sonicAnalyses).where(eq(sonicAnalyses.fileId, (await fileOf(key)).id))
    return row
  }
  const sweep = async () => {
    await sweepSonic()
    await drainJobs({ timeoutMs: 120_000 })
    resetSonicIndex()
  }
  const sonicOf = async (key: keyof typeof tracks) =>
    body(await app.inject({ method: 'GET', url: `/api/v1/tracks/${(await fileOf(key)).recordingId}/sonic`, headers }), TrackSonic)

  beforeAll(async () => {
    library = await mkdtemp(path.join(tmpdir(), 'squirmy-sonic-'))
    for (const track of Object.values(tracks)) {
      await makeBeatTrack(library, { durationSec: 24, ...track, tags: { ...track.tags, artist: album.artist, album_artist: album.artist, album: album.album } })
    }
    await updateServerSettings({ deezerEnabled: false, musicBrainzEnabled: false })
    await libraryModule.jobs!(jobs)
    await loudnessModule.jobs!(jobs)
    await sonicModule.jobs!(jobs)
    await startJobs({ work: true })
    rootId = (await insertRoot({ path: library, name: 'Library', mode: 'read_only', watch: false })).id
    await scanRoot({ rootId })
    await drainJobs({ timeoutMs: 120_000 })
    await sweep()
    app = await buildApp()
    headers = (await signIn()).headers
    adminHeaders = (await signIn({ role: 'admin' })).headers
  })
  afterAll(async () => {
    await app?.close()
    await stopProgress()
    await stopJobs()
    await rm(library, { recursive: true, force: true })
  })

  it('analyses every file once its loudness is known', async () => {
    for (const key of ['fast', 'slow', 'fastToo'] as const) {
      const row = await analysisOf(key)
      expect(row).toMatchObject({ version: ANALYSIS_VERSION, error: null, audioHash: (await fileOf(key)).audioHash })
      expect(row!.bpm).toBeCloseTo(tracks[key].bpm, 0)
      expect(row!.vector).toHaveLength(34)
    }
    expect(await analysisOf('fast')).toMatchObject({ key: 0, mode: 'major' })
    expect(await analysisOf('slow')).toMatchObject({ key: 9, mode: 'minor' })
    expect((await analysisOf('fast'))!.energy!).toBeGreaterThan((await analysisOf('slow'))!.energy!)
  })

  it('reads tempo, key and mood tags into the file tags', async () => {
    expect((await fileOf('tagged')).tags).toMatchObject({ bpm: 101, key: '8A', moods: ['Happy', 'Dreamy'] })
    expect((await fileOf('fast')).tags.bpm).toBeUndefined()
  })

  it('answers what a track sounds like, tags first', async () => {
    const tagged = await sonicOf('tagged')
    expect(tagged).toMatchObject({ analyzed: true, bpm: 101, bpmSource: 'tags', key: 'A minor', camelot: '8A', keySource: 'tags', moods: ['Happy', 'Dreamy'] })
    const fast = await sonicOf('fast')
    expect(fast).toMatchObject({ analyzed: true, bpmSource: 'analysis', key: 'C major', camelot: '8B', keySource: 'analysis', moods: [] })
    expect(fast.bpm).toBeCloseTo(128, 0)
    expect(fast.files).toHaveLength(1)
    expect(fast.files[0]).toMatchObject({ fileId: (await fileOf('fast')).id })
    expect(fast.files[0]!.outroStartMs!).toBeGreaterThan(20_000)
    const missing = await app.inject({ method: 'GET', url: '/api/v1/tracks/0190e7a0-0000-7000-8000-000000000000/sonic', headers })
    expect(missing.statusCode).toBe(404)
  })

  it('finds the tracks that sound alike', async () => {
    const fast = (await fileOf('fast')).recordingId!
    const neighbours = await sonicNeighbours([fast], { limit: 3 })
    expect(neighbours.map((one) => one.id)).not.toContain(fast)
    expect(neighbours[0]!.id).toBe((await fileOf('fastToo')).recordingId)
    expect(neighbours[0]!.similarity).toBeGreaterThan(neighbours.at(-1)!.similarity)
  })

  it('does nothing more on the next sweep', async () => {
    const before = await db.select({ fileId: sonicAnalyses.fileId, analyzedAt: sonicAnalyses.analyzedAt }).from(sonicAnalyses)
    await sweep()
    expect(await db.select({ fileId: sonicAnalyses.fileId, analyzedAt: sonicAnalyses.analyzedAt }).from(sonicAnalyses)).toEqual(before)
  })

  it('keeps a failure and does not retry it until the audio changes', async () => {
    const file = await fileOf('slow')
    const original = path.join(library, file.relPath)
    const saved = `${original}.saved`
    await writeFile(saved, await import('node:fs/promises').then((fs) => fs.readFile(original)))
    await writeFile(original, 'not audio at all')
    await analyzeFile({ fileId: file.id })
    expect((await analysisOf('slow'))!.error).toBeTruthy()
    expect((await analysisOf('slow'))!.vector).toBeNull()
    await sweep()
    expect((await analysisOf('slow'))!.error).toBeTruthy()
    // A different audio hash (the file was replaced) is analysed again.
    await import('node:fs/promises').then((fs) => fs.rename(saved, original))
    await db.update(mediaFiles).set({ audioHash: 'replaced' }).where(eq(mediaFiles.id, file.id))
    await sweep()
    expect(await analysisOf('slow')).toMatchObject({ error: null, audioHash: 'replaced', key: 9 })
  })

  it('reads tags with analysis off, and analyses once it is back on', async () => {
    await updateServerSettings({ sonicAnalysisEnabled: false })
    const file = await fileOf('tagged')
    await db.delete(sonicAnalyses).where(eq(sonicAnalyses.fileId, file.id))
    // As probed before Squirmy read these tags.
    await db.update(mediaFiles).set({ tags: sql`tags - 'bpm' - 'key' - 'moods'` }).where(eq(mediaFiles.id, file.id))
    await sweep()
    expect(await analysisOf('tagged')).toMatchObject({ version: null, vector: null })
    expect((await fileOf('tagged')).tags).toMatchObject({ bpm: 101, key: '8A' })
    expect(await sonicOf('tagged')).toMatchObject({ analyzed: false, bpm: 101, bpmSource: 'tags' })

    await updateServerSettings({ sonicAnalysisEnabled: true })
    await sweep()
    expect(await analysisOf('tagged')).toMatchObject({ version: ANALYSIS_VERSION, error: null })
    expect((await sonicOf('tagged')).analyzed).toBe(true)
  })

  it('reports progress on the library stats', async () => {
    const stats = body(await app.inject({ method: 'GET', url: '/api/v1/admin/library/stats', headers: adminHeaders }), LibraryStats)
    expect(stats.sonic).toEqual({ enabled: true, files: 4, analyzed: 4, failed: 0 })
  })

  it('asks Deezer for the tempo of a recording nothing else describes', async () => {
    await updateServerSettings({ deezerEnabled: true, sonicAnalysisEnabled: false })
    const file = await fileOf('fast')
    await db.update(sonicAnalyses).set({ bpm: null, version: null }).where(eq(sonicAnalyses.fileId, file.id))
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: '138539971', entityId: file.recordingId! })
    await sweep()
    expect(await db.select().from(sonicHints).where(eq(sonicHints.recordingId, file.recordingId!))).toMatchObject([{ deezerBpm: 168.06 }])
    expect(await sonicOf('fast')).toMatchObject({ bpm: 168.1, bpmSource: 'deezer' })
    // Checked: not asked again on the next sweep.
    const [{ checkedAt }] = await db.select({ checkedAt: sonicHints.deezerCheckedAt }).from(sonicHints).where(eq(sonicHints.recordingId, file.recordingId!)) as [{ checkedAt: Date }]
    await sweep()
    expect((await db.select().from(sonicHints).where(eq(sonicHints.recordingId, file.recordingId!)))[0]!.deezerCheckedAt).toEqual(checkedAt)
    await updateServerSettings({ deezerEnabled: false, sonicAnalysisEnabled: true })
  })
})
