import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CatalogIndexStatus } from '@squirmy/contracts'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { getConfig } from '../../config.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { buildDump, testCatalog } from './fixtures.js'
import { catalogIndexModule } from './index.js'
import { isCatalogIndexReady, searchCatalogIndex } from './search.js'

describe('catalog index admin routes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  let member: { authorization: string }
  let dump = ''

  const call = (options: InjectOptions) => app.inject(options)
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
      sizeBytes: expect.any(Number), active: null, latest: null,
    })
  })

  it('imports through the job and reports the result', async () => {
    const response = await call({ method: 'POST', url: '/api/v1/admin/catalog-index/import', headers: admin, payload: { source: dump, recordingsPerArtist: 1000 } })
    expect(response.statusCode).toBe(202)
    await drainJobs()

    const current = await status()
    expect(current).toMatchObject({
      ready: true,
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
