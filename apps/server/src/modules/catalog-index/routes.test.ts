import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CatalogIndexStatus } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { catalogIndexImports } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { buildDump, testCatalog } from '../../test/catalog-index-dump.js'
import { catalogIndexModule } from './index.js'
import { isCatalogIndexReady, searchCatalogIndex } from './search.js'

// Recovery in this suite is triggered explicitly. The cron worker could otherwise take a
// simulated abandoned import between its insertion and the request that is meant to recover it.
vi.mock(import('../../jobs/index.js'), async (original) => ({
  ...(await original()),
  schedule: vi.fn(),
}))

describe('catalog index admin routes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  let member: { authorization: string }
  let dump = ''

  const call = (options: InjectOptions) => app.inject(options)
  // Stands in for a live import in another process: it holds the import's advisory lock.
  const holdImportLock = async () => {
    const sql = await getSql().reserve()
    await sql`select pg_advisory_lock(hashtext('squirmy:catalog-index-import'))`
    return async () => {
      await sql`select pg_advisory_unlock(hashtext('squirmy:catalog-index-import'))`
      sql.release()
    }
  }
  const status = async () => (await call({ url: '/api/v1/admin/catalog-index', headers: admin })).json() as CatalogIndexStatus

  beforeAll(async () => {
    await catalogIndexModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    admin = { authorization: `Bearer ${setup.json().token}` }
    await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'mira', password: 'mira password' } })
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mira', password: 'mira password' } })
    member = { authorization: `Bearer ${login.json().token}` }
    dump = path.join(getConfig().SQUIRMY_DATA_DIR, 'dump.tar.zst')
    await writeFile(dump, buildDump(testCatalog()))
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  it('is for admins only', async () => {
    expect((await call({ url: '/api/v1/admin/catalog-index' })).statusCode).toBe(401)
    expect((await call({ url: '/api/v1/admin/catalog-index', headers: member })).statusCode).toBe(403)
    expect((await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: member, payload: {} })).statusCode).toBe(403)
    expect((await call({ method: 'DELETE', url: '/api/v1/admin/catalog-index', headers: member })).statusCode).toBe(403)
  })

  it('reports an empty index before the first import', async () => {
    expect(await status()).toEqual({
      ready: false, dumpDate: null, importedAt: null, counts: { artists: 0, albums: 0, recordings: 0 },
      sizeBytes: expect.any(Number), searchUpgrade: null, active: null, latest: null,
    })
  })

  it('imports through the job and reports the result', async () => {
    const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { source: dump, recordingsPerArtist: 1000 } })
    expect(response.statusCode).toBe(202)
    await drainJobs()

    const current = await status()
    expect(current).toMatchObject({
      ready: true,
      searchUpgrade: 'ready',
      dumpDate: '2026-11-17T08:00:03.201Z',
      counts: { artists: 9, albums: 11 },
      active: { state: 'active', source: dump, recordingsPerArtist: 1000, error: null },
      latest: null,
    })
    expect(current.counts.recordings).toBeGreaterThan(50)
    expect(current.sizeBytes).toBeGreaterThan(0)
    expect(await isCatalogIndexReady()).toBe(true)
  })

  it('records a failed import without losing the index', async () => {
    const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { source: '/nowhere/dump.tar.zst' } })
    expect(response.statusCode).toBe(202)
    await drainJobs()
    const current = await status()
    expect(current).toMatchObject({ ready: true, latest: { state: 'failed', source: '/nowhere/dump.tar.zst' } })
    expect(current.latest?.error).toMatch(/ENOENT/)
  })

  it('cancels a running import and keeps the index', async () => {
    const idle = await call({ method: 'DELETE', url: '/api/v1/admin/catalog-index/import', headers: admin })
    expect(idle.statusCode).toBe(409)
    expect(idle.json()).toMatchObject({ error: { code: 'catalog_index_import_not_running' } })

    const release = await holdImportLock()
    const [running] = await db.insert(catalogIndexImports).values({ id: newId(), state: 'running', phase: 'download' }).returning()
    const response = await call({ method: 'DELETE', url: '/api/v1/admin/catalog-index/import', headers: admin })
    await release()
    expect(response.json()).toEqual({ ok: true })
    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, running!.id))
    expect(row!.cancelRequested).toBe(true)
    expect(row!.state).toBe('running')
    await db.update(catalogIndexImports).set({ state: 'cancelled' }).where(eq(catalogIndexImports.id, running!.id))
    expect(await status()).toMatchObject({ ready: true, latest: { state: 'cancelled' } })
    expect(await isCatalogIndexReady()).toBe(true)
  })

  it('refuses a second import while one is running', async () => {
    const release = await holdImportLock()
    const [running] = await db.insert(catalogIndexImports).values({ id: newId(), state: 'running', phase: 'download' }).returning()
    try {
      const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { source: dump } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code: 'catalog_index_import_running' } })
    } finally {
      await release()
      await db.update(catalogIndexImports).set({ state: 'cancelled' }).where(eq(catalogIndexImports.id, running!.id))
    }
  })

  it('resumes an import whose process died instead of starting another', async () => {
    // A killed worker leaves its row running and no lock behind.
    const [dead] = await db.insert(catalogIndexImports).values({ id: newId(), state: 'running', phase: 'build', source: dump }).returning()
    const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { source: '/nowhere/dump.tar.zst' } })
    expect(response.statusCode).toBe(409)
    await drainJobs()
    const current = await status()
    expect(current).toMatchObject({ ready: true, latest: null, active: { id: dead!.id, state: 'active', resumes: 1, resumedAt: expect.any(String) } })
  })

  it('cancelling an interrupted import ends it', async () => {
    const [dead] = await db.insert(catalogIndexImports).values({ id: newId(), state: 'running', phase: 'download' }).returning()
    const response = await call({ method: 'DELETE', url: '/api/v1/admin/catalog-index/import', headers: admin })
    expect(response.json()).toEqual({ ok: true })
    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, dead!.id))
    expect(row).toMatchObject({ state: 'cancelled', error: null, finishedAt: expect.any(Date) })
  })

  it('queues a resume for imports left running by a dead process when the worker starts', async () => {
    const [dead] = await db.insert(catalogIndexImports).values({ id: newId(), state: 'running', phase: 'download', source: dump, recordingsPerArtist: 1000 }).returning()
    await catalogIndexModule.start!({ role: 'worker' })
    const queued = await getSql()<{ key: string }[]>`select singleton_key as key from pgboss.job where name = 'catalog-index.import' and singleton_key like ${`catalog-index:resume:${dead!.id}:%`}`
    expect(queued.map((job) => job.key)).toEqual([`catalog-index:resume:${dead!.id}:0`])
    await drainJobs()
    expect(await status()).toMatchObject({ active: { id: dead!.id, state: 'active', recordingsPerArtist: 1000, resumes: 1 } })
  })

  it('validates the request', async () => {
    const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { recordingsPerArtist: 0 } })
    expect(response.statusCode).toBe(400)
  })

  it('drops the index', async () => {
    const response = await call({ method: 'DELETE', url: '/api/v1/admin/catalog-index', headers: admin })
    expect(response.json()).toEqual({ ok: true })
    expect(await status()).toMatchObject({ ready: false, counts: { recordings: 0 }, active: null })
    expect(await isCatalogIndexReady()).toBe(false)
    expect(await searchCatalogIndex('yesterday')).toEqual([])
  })
})
