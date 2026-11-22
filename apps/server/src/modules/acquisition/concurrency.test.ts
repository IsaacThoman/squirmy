import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { AcquireResponse } from '@squirmy/contracts'
import { inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { closeDb, db, poolSize } from '../../database/client.js'
import { acquisitionJobs, imports } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { importsModule } from '../imports/index.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { matchingModule } from '../matching/index.js'
import { acquisitionModule } from './index.js'
import { configureAcquisition } from './jobs.js'
import { updateAcquisitionPolicy } from './policy.js'
import { createProvider } from './providers.js'

/**
 * Parallel fetches are ordinary traffic: the player prepares five tracks ahead, so a queue
 * started from an album asks for six at once. Every one of them must arrive, whatever the
 * size of the connection pool, with more deliveries in flight than the pool has connections.
 */

async function eventually(check: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe.each([
  { pool: 4, label: 'the test pool' },
  { pool: 10, label: 'the production pool' },
])('parallel acquisitions with $label ($pool connections)', ({ pool }) => {
  useTestDatabase()
  const secret = 'concurrency-provider-secret'
  let app: FastifyInstance
  let mock: MockProvider
  let rootDir = ''

  beforeAll(async () => {
    process.env.SQUIRMY_DB_POOL_SIZE = String(pool)
    resetConfig()
    await closeDb()
    expect(poolSize()).toBe(pool)
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    app = await buildApp()
    await app.listen({ host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    for (const module of [libraryModule, matchingModule, importsModule, acquisitionModule]) await module.jobs!(jobs)
    await startJobs({ work: true })
    configureAcquisition({ pollMs: 100 })

    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-concurrent-')))
    const root = await insertRoot({ name: 'Acquired', path: rootDir, mode: 'managed', watch: false })
    await updateServerSettings({ importRootId: root.id })
    await updateAcquisitionPolicy({ deliveryBaseUrl: url })
    // More slots than the pool has connections, so every delivery imports at once.
    mock = createMockProvider({ secret, maxConcurrent: 8, onError: () => {} })
    await createProvider({ name: 'Mock', baseUrl: await mock.listen(), secret, enabled: true, priority: 0 })
  }, 60_000)

  afterAll(async () => {
    delete process.env.SQUIRMY_DB_POOL_SIZE
    await stopJobs()
    await mock.close()
    await app.close()
    await rm(rootDir, { recursive: true, force: true })
  }, 60_000)

  it('delivers eight tracks requested at once, as a queue fetched ahead does', async () => {
    const fan = await signIn({ canAcquire: true })
    const album = await createAlbum({ tracks: Array.from({ length: 8 }, (_, index) => ({ title: `Ahead ${index + 1}`, durationMs: 2000 })) })
    const wanted = album.tracks.map((track) => track.recordingId)
    const responses = await Promise.all(wanted.map((id) => app.inject({
      method: 'POST', url: `/api/v1/tracks/${id}/acquire?albumId=${album.albumId}`, headers: fan.headers,
    })))
    const ids = responses.map((response) => body(response, AcquireResponse, 202).items[0]!.id)
    expect(new Set(ids).size).toBe(8)

    await eventually(async () => {
      const rows = await db.select({ status: acquisitionJobs.status }).from(acquisitionJobs).where(inArray(acquisitionJobs.id, ids))
      expect(rows.map((row) => row.status)).toEqual(ids.map(() => 'completed'))
    }, 45_000)
    await drainJobs()
    const done = await db.select({ status: imports.status }).from(imports).where(inArray(imports.acquisitionJobId, ids))
    expect(done.map((row) => row.status)).toEqual(ids.map(() => 'completed'))
  }, 60_000)
})
