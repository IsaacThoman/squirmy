import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { queryKeys } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetConfig } from '../../config.js'
import { closeDb, db, getSql } from '../../database/client.js'
import { acquisitionMisses, acquisitionOffers, acquisitionProviders, albums } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { createFile } from '../../test/catalog.js'
import { albumAvailability, trackAvailability } from '../catalog/availability.js'
import { acquisitionModule } from './index.js'
import { onDemandRecordings } from './coverage.js'
import { createProvider, invalidateProviders, testProvider, updateProvider } from './providers.js'
import { configureResolve, flushResolves, MISS_TTL_MS, recordMisses, resetResolveQueue } from './resolve.js'

/** Collects `invalidate` keys published on the realtime channel. */
async function invalidations() {
  const keys: unknown[][] = []
  const listener = await getSql().listen('squirmy_events', (payload) => {
    const message = JSON.parse(payload) as { kind: string; keys?: unknown[][] }
    if (message.kind === 'invalidate') keys.push(...message.keys!)
  })
  return { keys, stop: () => listener.unlisten() }
}

describe('on-demand coverage', () => {
  useTestDatabase()
  let mock: MockProvider
  let url = ''

  beforeAll(async () => {
    await acquisitionModule.jobs!(jobs)
    await startJobs({ work: true })
    mock = createMockProvider({ secret: 'coverage-secret' })
    url = await mock.listen()
    // Batches are flushed by hand.
    configureResolve({ debounceMs: 60_000 })
  })
  beforeEach(async () => {
    await db.delete(acquisitionProviders)
    invalidateProviders()
    resetResolveQueue()
    mock.resolved.length = 0
    mock.settings.has = () => true
  })
  afterEach(() => resetResolveQueue())
  afterAll(async () => {
    await stopJobs()
    await mock.close()
  })

  /** An album as a catalog search leaves it: no release, so no track list yet. */
  const createStubAlbum = async () => {
    const id = newId()
    await db.insert(albums).values({ id, title: `Stub ${id}`, artistCredit: 'Someone', titleKey: 'stub', matchKey: `someone|stub ${id}`, type: 'album', detailLevel: 0 })
    return id
  }

  const provider = async (coverage: 'assume_available' | 'must_resolve', enabled = true) => {
    mock.settings.coverage = coverage
    const created = await createProvider({ name: coverage, baseUrl: url, secret: 'coverage-secret', enabled, priority: 0 })
    expect(created.coverage).toBe(coverage)
    return created
  }

  it('does no work at all while no provider is enabled', async () => {
    const album = await createAlbum()
    await provider('assume_available', false)
    const ids = album.tracks.map((track) => track.recordingId)
    expect(await onDemandRecordings(ids)).toEqual(new Set())
    // With the provider list cached, it never reaches the database: point it at one that does not exist.
    const realUrl = process.env.DATABASE_URL
    await closeDb()
    process.env.DATABASE_URL = 'postgres://localhost:1/nowhere'
    resetConfig()
    try {
      const started = performance.now()
      for (let round = 0; round < 1000; round += 1) expect((await onDemandRecordings(ids)).size).toBe(0)
      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      process.env.DATABASE_URL = realUrl
      resetConfig()
      await closeDb()
    }
  })

  it('covers everything an assume_available provider has not missed, until the miss expires', async () => {
    const created = await provider('assume_available')
    const root = await createLibraryRoot()
    const album = await createAlbum({ tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] })
    const [one, two, three] = album.tracks.map((track) => track.recordingId) as [string, string, string]
    await createFile({ rootId: root.id, recordingId: three })
    await recordMisses(db, created.id, 'recording', [two], 'test')

    expect(await onDemandRecordings([one, two])).toEqual(new Set([one]))
    expect(await trackAvailability([one, two, three])).toEqual(new Map([[one, 'on_demand'], [two, 'none'], [three, 'server']]))
    expect((await albumAvailability([album.albumId])).get(album.albumId)?.availability).toBe('partial')

    await db.update(acquisitionMisses).set({ createdAt: new Date(Date.now() - MISS_TTL_MS - 1000) })
      .where(and(eq(acquisitionMisses.providerId, created.id), eq(acquisitionMisses.entityId, two)))
    expect(await onDemandRecordings([one, two])).toEqual(new Set([one, two]))
    // assume_available never asks first.
    await flushResolves()
    expect(mock.resolved).toEqual([])
  })

  it('covers only resolved recordings for a must_resolve provider, resolving the rest in batches and invalidating what lit up', async () => {
    const created = await provider('must_resolve')
    const album = await createAlbum({ title: 'Big Box', tracks: Array.from({ length: 250 }, (_, index) => ({ title: `Track ${index + 1}` })) })
    const ids = album.tracks.map((track) => track.recordingId)
    // It has every other track.
    mock.settings.has = (item) => item.kind === 'recording' && Number(item.recording.title.split(' ')[1]) % 2 === 1

    const gray = await albumAvailability([album.albumId])
    expect(gray.get(album.albumId)?.availability).toBe('none')
    expect(await onDemandRecordings(ids)).toEqual(new Set())
    // Asked again before the answer: queued once only.
    expect(await onDemandRecordings(ids)).toEqual(new Set())

    const events = await invalidations()
    await flushResolves()
    const queued = await db.execute<{ size: number }>(sql`
      select jsonb_array_length(data->'recordingIds') as size from pgboss.job where name = 'acquisition.resolve' order by size desc`)
    expect(queued.map((job) => job.size)).toEqual([100, 100, 50])
    await drainJobs()
    await events.stop()

    expect(mock.resolved).toHaveLength(250)
    // The batches resolve concurrently, so the first track can arrive in any position.
    const first = mock.resolved.find((item) => item.kind === 'recording' && item.recording.title === 'Track 1')
    expect(first).toMatchObject({ kind: 'recording', recording: { title: 'Track 1', artist: album.artist.name, album: { title: 'Big Box', position: 1, disc: 1 } } })
    const odd = ids.filter((_, index) => index % 2 === 0)
    expect(await onDemandRecordings(ids)).toEqual(new Set(odd))
    expect(await db.$count(acquisitionOffers, eq(acquisitionOffers.providerId, created.id))).toBe(125)
    expect(await db.$count(acquisitionMisses, eq(acquisitionMisses.providerId, created.id))).toBe(125)
    expect(events.keys).toContainEqual([...queryKeys.track(odd[0]!)])
    expect(events.keys).toContainEqual([...queryKeys.album(album.albumId)])
    expect(events.keys).not.toContainEqual([...queryKeys.track(ids[1]!)])

    // Answered recordings are not asked about again.
    mock.resolved.length = 0
    await onDemandRecordings(ids)
    await flushResolves()
    await drainJobs()
    expect(mock.resolved).toEqual([])
  })

  it('takes the coverage an admin sets over the declared one, also after capabilities are asked again', async () => {
    const declared = await provider('must_resolve')
    const album = await createAlbum({ tracks: [{ title: 'Never Resolved' }] })
    const stub = await createStubAlbum()
    const id = album.tracks[0]!.recordingId
    expect(await onDemandRecordings([id])).toEqual(new Set())
    expect((await albumAvailability([stub])).get(stub)?.availability).toBe('none')
    resetResolveQueue()

    expect(await updateProvider(declared.id, { coverage: 'assume_available' })).toMatchObject({ coverage: 'assume_available' })
    expect(await onDemandRecordings([id])).toEqual(new Set([id]))
    // An album search found, with no track list yet, plays too.
    expect((await albumAvailability([stub])).get(stub)).toEqual({ availability: 'on_demand', trackCount: 0, ownedTrackCount: 0 })

    const refreshed = await testProvider(declared.id)
    expect(refreshed).toMatchObject({ coverage: 'assume_available', capabilities: { coverage: 'must_resolve' }, lastError: null })
    expect(await onDemandRecordings([id])).toEqual(new Set([id]))
    const [row] = await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, declared.id))
    expect(row).toMatchObject({ coverage: 'must_resolve', coverageOverride: 'assume_available' })
    expect(mock.resolved).toEqual([])
  })

  it('leaves recordings unanswered when the provider is down, and asks again later', async () => {
    await provider('must_resolve')
    const album = await createAlbum({ tracks: [{ title: 'Lonely' }] })
    const id = album.tracks[0]!.recordingId
    await mock.close()
    try {
      expect(await onDemandRecordings([id])).toEqual(new Set())
      await flushResolves()
      await drainJobs()
      expect(await db.$count(acquisitionMisses)).toBe(0)
      const [row] = await db.select().from(acquisitionProviders)
      expect(row!.lastError).toMatch(/Could not reach the provider/)
    } finally {
      mock = createMockProvider({ secret: 'coverage-secret' })
      url = await mock.listen(Number(new URL(url).port))
    }
  })
})
