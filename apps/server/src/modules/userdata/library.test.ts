import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { AlbumDetail, Ok, queryKeys } from '@squirmy/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionProviders, albums, libraryItems } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { createProvider, invalidateProviders } from '../acquisition/providers.js'
import { albumDetailRun } from '../enrichment/detail.js'
import { insertRoot } from '../library/roots.js'
import { mergeAlbum, mergeRecording } from '../matching/merge.js'
import { cleanupStubs } from '../search/cleanup.js'
import { userdataModule } from './index.js'

vi.mock('../../realtime/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../realtime/index.js')>(),
  invalidate: vi.fn(async () => {}),
}))
vi.mock('../enrichment/detail.js', () => ({
  ensureAlbumDetail: vi.fn(async () => {}),
  ensureArtistDetail: vi.fn(async () => {}),
  ensureLyrics: vi.fn(async () => {}),
  albumDetailRun: vi.fn(async () => {}),
}))
const invalidated = vi.mocked(invalidate)

/** `PUT/DELETE /me/library/:type/:id`: saves, removals, merges, and fetching what a save lacks. */
describe('library saves', () => {
  useTestDatabase()
  let app: FastifyInstance
  let mira: Awaited<ReturnType<typeof signIn>>
  let fan: Awaited<ReturnType<typeof signIn>>
  let mock: MockProvider
  let rootDir = ''

  const call = (who: { headers: Record<string, string> }, options: InjectOptions) =>
    app.inject({ ...options, url: `/api/v1${options.url as string}`, headers: who.headers })
  const saved = (userId: string) => db.select().from(libraryItems).where(eq(libraryItems.userId, userId))

  beforeAll(async () => {
    app = await buildApp()
    mira = await signIn({ username: 'mira' })
    fan = await signIn({ username: 'fan', canAcquire: true })
    // Only this module's job runs, so the fetches it asks for stay queued for inspection.
    await userdataModule.jobs!(jobs)
    await startJobs({ work: true })
    mock = createMockProvider({ secret: 'library-secret', onError: () => {} })
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-library-saves-')))
    const root = await insertRoot({ name: 'Fetched', path: rootDir, mode: 'managed', watch: false })
    await updateServerSettings({ importRootId: root.id })
  })
  beforeEach(async () => {
    invalidated.mockClear()
    await db.delete(acquisitionProviders)
    invalidateProviders()
  })
  afterAll(async () => {
    await stopJobs()
    await mock.close()
    await app.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('saves and removes idempotently, and refuses unknown ids', async () => {
    const album = await createAlbum()
    const [track] = album.tracks
    for (let round = 0; round < 2; round++) {
      body(await call(mira, { method: 'PUT', url: `/me/library/album/${album.albumId}` }), Ok)
      body(await call(mira, { method: 'PUT', url: `/me/library/track/${track!.recordingId}` }), Ok)
    }
    expect((await saved(mira.id)).map((row) => row.entityType).sort()).toEqual(['album', 'recording'])
    const keys = invalidated.mock.calls.flatMap(([target, list]) => (expect(target).toEqual({ user: mira.id }), list))
    for (const key of [queryKeys.library(), queryKeys.home(), queryKeys.album(album.albumId), queryKeys.track(track!.recordingId), queryKeys.artist(album.artist.id)]) {
      expect(keys).toContainEqual(key)
    }

    for (let round = 0; round < 2; round++) {
      body(await call(mira, { method: 'DELETE', url: `/me/library/album/${album.albumId}` }), Ok)
      body(await call(mira, { method: 'DELETE', url: `/me/library/track/${track!.recordingId}` }), Ok)
    }
    expect(await saved(mira.id)).toEqual([])

    const missing = '01900000-0000-7000-8000-000000000000'
    expect(errorCode(await call(mira, { method: 'PUT', url: `/me/library/album/${missing}` }), 404)).toBe('album_not_found')
    expect(errorCode(await call(mira, { method: 'PUT', url: `/me/library/track/${missing}` }), 404)).toBe('track_not_found')
    expect(errorCode(await call(mira, { method: 'PUT', url: `/me/library/artist/${album.artist.id}` }), 400)).toBe('invalid_request')
    body(await call(mira, { method: 'DELETE', url: `/me/library/album/${missing}` }), Ok)
    expect(errorCode(await app.inject({ method: 'PUT', url: `/api/v1/me/library/album/${album.albumId}` }), 401)).toBe('unauthorized')
  })

  it('follows merges: saves of a merged id land on the survivor and merges repoint saves', async () => {
    const [loser, winner, other] = [await createAlbum(), await createAlbum(), await createAlbum()]
    await mergeAlbum(loser.albumId, winner.albumId)
    body(await call(mira, { method: 'PUT', url: `/me/library/album/${loser.albumId}` }), Ok)
    expect((await saved(mira.id)).map((row) => row.entityId)).toEqual([winner.albumId])
    expect(body(await call(mira, { url: `/albums/${loser.albumId}` }), AlbumDetail).library).toBe('saved')
    body(await call(mira, { method: 'DELETE', url: `/me/library/album/${loser.albumId}` }), Ok)
    expect(await saved(mira.id)).toEqual([])

    // A merge moves saves; where the user saved both, the older save stays.
    const older = new Date('2026-01-01T00:00:00Z')
    await db.insert(libraryItems).values([
      { userId: mira.id, entityType: 'album', entityId: other.albumId, createdAt: older },
      { userId: mira.id, entityType: 'album', entityId: winner.albumId },
      { userId: fan.id, entityType: 'album', entityId: other.albumId },
      { userId: mira.id, entityType: 'recording', entityId: other.tracks[0]!.recordingId },
    ])
    await mergeAlbum(other.albumId, winner.albumId)
    await mergeRecording(other.tracks[0]!.recordingId, winner.tracks[0]!.recordingId)
    const rows = await db.select().from(libraryItems)
    expect(rows.filter((row) => row.entityType === 'album').map((row) => [row.userId, row.entityId, row.createdAt.getTime() === older.getTime() || row.userId === fan.id]))
      .toEqual(expect.arrayContaining([[mira.id, winner.albumId, true], [fan.id, winner.albumId, true]]))
    expect(rows.filter((row) => row.entityType === 'album')).toHaveLength(2)
    expect(rows.find((row) => row.entityType === 'recording')!.entityId).toBe(winner.tracks[0]!.recordingId)
    await db.delete(libraryItems)
  })

  it('keeps saved search stubs through the stub cleanup', async () => {
    const [stub, unkept] = [await createAlbum({ title: 'Stub' }), await createAlbum({ title: 'Unkept' })]
    await db.update(albums).set({ detailLevel: 0, createdAt: new Date(Date.now() - 60 * 86_400_000) }).where(inArray(albums.id, [stub.albumId, unkept.albumId]))
    await db.insert(libraryItems).values({ userId: mira.id, entityType: 'album', entityId: stub.albumId })
    await cleanupStubs()
    const left = await db.select({ id: albums.id }).from(albums).where(inArray(albums.id, [stub.albumId, unkept.albumId]))
    expect(left.map((row) => row.id)).toEqual([stub.albumId])
    await db.delete(libraryItems)
  })

  it('asks the provider for what a requester saved, and never fails the save', async () => {
    const stub = await createAlbum({ title: 'Not here yet' })
    // Nothing is fetched without a provider, or for a member who may not fetch.
    body(await call(fan, { method: 'PUT', url: `/me/library/album/${stub.albumId}` }), Ok)
    await createProvider({ name: 'Mock', baseUrl: await mock.listen(), secret: 'library-secret', enabled: true, priority: 0 })
    body(await call(mira, { method: 'PUT', url: `/me/library/album/${stub.albumId}` }), Ok)
    await drainJobs()
    expect(await db.select().from(acquisitionJobs)).toEqual([])

    await db.delete(libraryItems).where(eq(libraryItems.userId, fan.id))
    body(await call(fan, { method: 'PUT', url: `/me/library/album/${stub.albumId}` }), Ok)
    await drainJobs()
    expect(vi.mocked(albumDetailRun)).toHaveBeenCalledWith(stub.albumId)
    const fetches = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.requestedBy, fan.id))
    expect(fetches.flatMap((job) => job.recordingIds).sort()).toEqual(stub.tracks.map((track) => track.recordingId).sort())
    expect(fetches.every((job) => job.albumId === stub.albumId)).toBe(true)

    // A single track the same way; one already fetching is not asked for twice.
    const single = await createAlbum({ title: 'One song' })
    body(await call(fan, { method: 'PUT', url: `/me/library/track/${single.tracks[1]!.recordingId}` }), Ok)
    await drainJobs()
    const [job] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.recordingId, single.tracks[1]!.recordingId))
    expect(job).toMatchObject({ requestedBy: fan.id, recordingIds: [single.tracks[1]!.recordingId] })

    // A provider gone by the time the fetch runs refuses it, but the save stands.
    const later = await createAlbum({ title: 'Later' })
    body(await call(fan, { method: 'PUT', url: `/me/library/album/${later.albumId}` }), Ok)
    await db.delete(acquisitionProviders)
    invalidateProviders()
    await drainJobs()
    expect(await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.albumId, later.albumId))).toEqual([])
    expect(await db.select().from(libraryItems).where(and(eq(libraryItems.userId, fan.id), eq(libraryItems.entityId, later.albumId)))).toHaveLength(1)
  })
})
