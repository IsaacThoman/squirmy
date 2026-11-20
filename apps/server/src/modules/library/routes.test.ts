import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { albums, libraryRoots } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { libraryModule } from './index.js'
import { stopProgress } from './progress.js'
import { addConfiguredRoots } from './roots.js'

describe('library roots API', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  let member: { authorization: string }
  let base = ''
  let music = ''

  const call = (options: InjectOptions) => app.inject(options)
  const create = (payload: object, headers = admin) => call({ method: 'POST', url: '/api/v1/admin/library/roots', headers, payload })

  beforeAll(async () => {
    // Roots are stored by their real path, and macOS's temp folder is a symlink.
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-roots-')))
    music = path.join(base, 'music')
    await makeAlbum(music, { artist: 'Mira Vale', album: 'Blue Hour', tracks: [{ title: 'Night Swimming', durationSec: 1 }, { title: 'Soft Signal', durationSec: 1 }] })
    await mkdir(path.join(base, 'other'))
    await writeFile(path.join(base, 'file.txt'), 'not a folder')

    await libraryModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    admin = { authorization: `Bearer ${setup.json().token}` }
    await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'mira', password: 'mira password' } })
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mira', password: 'mira password' } })
    member = { authorization: `Bearer ${login.json().token}` }
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    // Its debounce timers would otherwise fire after the database is gone.
    await stopProgress()
    await rm(base, { recursive: true, force: true })
  })

  it('is for admins only', async () => {
    expect((await call({ url: '/api/v1/admin/library/roots' })).statusCode).toBe(401)
    expect((await call({ url: '/api/v1/admin/library/roots', headers: member })).statusCode).toBe(403)
    expect((await create({ name: 'Music', path: music }, member)).statusCode).toBe(403)
    expect((await call({ url: '/api/v1/admin/library/stats', headers: member })).statusCode).toBe(403)
  })

  it('validates the path', async () => {
    const error = async (payload: object) => (await create(payload)).json().error.code
    expect(await error({ name: 'Relative', path: 'music' })).toBe('relative_path')
    expect(await error({ name: 'Missing', path: path.join(base, 'nope') })).toBe('path_not_found')
    expect(await error({ name: 'File', path: path.join(base, 'file.txt') })).toBe('not_a_directory')
    expect(await error({ name: '', path: music })).toBe('invalid_request')
  })

  it('creates a root, scans it and reports live counts', async () => {
    const created = await create({ name: 'Music', path: music, watch: false })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ name: 'Music', path: music, mode: 'read_only', enabled: true, watch: false })
    await drainJobs()

    const [root] = (await call({ url: '/api/v1/admin/library/roots', headers: admin })).json().items
    expect(root).toMatchObject({ id: created.json().id, scanning: false, fileCount: 2, lastScanStats: { filesSeen: 2, filesAdded: 2, filesChanged: 0, filesMissing: 0, errors: 0 } })
    expect(root.lastScanFinishedAt).not.toBeNull()

    const stats = (await call({ url: '/api/v1/admin/library/stats', headers: admin })).json()
    expect(stats).toMatchObject({ artists: 1, albums: 1, tracks: 2, files: 2, pending: 2, matched: 0, missing: 0 })
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.durationMs).toBeGreaterThan(1500)
  })

  it('sets a path template, checked by organize, and clears it with null', async () => {
    const created = await create({ name: 'Tidy', path: path.join(base, 'tidy'), mode: 'managed', template: '{artist}/{title}.{ext}' })
    expect(created.json().error.code).toBe('path_not_found')
    await mkdir(path.join(base, 'tidy'))
    const invalid = await create({ name: 'Tidy', path: path.join(base, 'tidy'), mode: 'managed', template: '{artist}/{title}' })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toMatchObject({
      code: 'invalid_request',
      message: 'The file name must end with .{ext}',
      details: [{ path: ['template'], message: 'The file name must end with .{ext}' }],
    })
    const root = (await create({ name: 'Tidy', path: path.join(base, 'tidy'), mode: 'managed', template: '{artist}/{title}.{ext}' })).json()
    expect(root).toMatchObject({ mode: 'managed', template: '{artist}/{title}.{ext}' })

    const url = `/api/v1/admin/library/roots/${root.id}`
    const unknown = await call({ method: 'PATCH', url, headers: admin, payload: { template: '{album}/{song}.{ext}' } })
    expect(unknown.json().error.details).toEqual([expect.objectContaining({ path: ['template'], message: 'Unknown token {song}' })])
    expect((await call({ method: 'PATCH', url, headers: admin, payload: { template: '{album}/{track} {title}.{ext}' } })).json().template).toBe('{album}/{track} {title}.{ext}')
    expect((await call({ method: 'PATCH', url, headers: admin, payload: { name: 'Tidier' } })).json().template).toBe('{album}/{track} {title}.{ext}')
    expect((await call({ method: 'PATCH', url, headers: admin, payload: { template: null } })).json().template).toBeNull()
    expect((await call({ method: 'DELETE', url, headers: admin })).statusCode).toBe(200)
  })

  it('refuses duplicate and nested roots', async () => {
    expect((await create({ name: 'Again', path: music })).json().error.code).toBe('duplicate_root')
    expect((await create({ name: 'Again', path: `${music}/` })).json().error.code).toBe('duplicate_root')
    expect((await create({ name: 'Inside', path: path.join(music, 'Mira Vale') })).json().error.code).toBe('nested_root')
    expect((await create({ name: 'Around', path: base })).json().error.code).toBe('nested_root')
    expect((await create({ name: 'Other', path: path.join(base, 'other') })).statusCode).toBe(201)
  })

  it('updates, rescans and deletes a root without touching disk', async () => {
    const [root] = (await call({ url: '/api/v1/admin/library/roots', headers: admin })).json().items.filter((item: { name: string }) => item.name === 'Music')
    const url = `/api/v1/admin/library/roots/${root.id}`
    const updated = await call({ method: 'PATCH', url, headers: admin, payload: { name: 'Main', enabled: false } })
    expect(updated.json()).toMatchObject({ name: 'Main', enabled: false })
    expect((await call({ method: 'POST', url: `${url}/scan`, headers: admin })).json().error.code).toBe('root_disabled')
    await call({ method: 'PATCH', url, headers: admin, payload: { enabled: true } })
    await drainJobs()
    const scan = await call({ method: 'POST', url: `${url}/scan`, headers: admin })
    expect(scan.statusCode).toBe(202)
    expect(scan.json()).toEqual({ queued: true })
    await drainJobs()

    expect((await call({ method: 'DELETE', url, headers: admin })).json()).toEqual({ ok: true })
    expect((await call({ method: 'DELETE', url, headers: admin })).statusCode).toBe(404)
    expect(await db.select().from(albums)).toHaveLength(0)
    await access(path.join(music, 'Mira Vale/Blue Hour/01 Night Swimming.flac'))
    expect((await call({ url: '/api/v1/admin/library/stats', headers: admin })).json()).toMatchObject({ files: 0, albums: 0, artists: 0 })
  })

  it('adds SQUIRMY_LIBRARY_PATHS roots once', async () => {
    process.env.SQUIRMY_LIBRARY_PATHS = `${music}, ${path.join(base, 'other')}, ${path.join(base, 'nope')}`
    resetConfig()
    try {
      await addConfiguredRoots()
      await addConfiguredRoots()
    } finally {
      delete process.env.SQUIRMY_LIBRARY_PATHS
      resetConfig()
    }
    const roots = await db.select().from(libraryRoots)
    expect(roots.map((root) => root.path).sort()).toEqual([music, path.join(base, 'other')].sort())
    expect(roots.find((root) => root.path === music)).toMatchObject({ name: 'music', mode: 'read_only' })
    await drainJobs()
  })

  it('reports a queued scan as scanning', async () => {
    // With workers off, a requested scan stays queued.
    await stopJobs()
    await startJobs({ work: false })
    try {
      const [root] = (await call({ url: '/api/v1/admin/library/roots', headers: admin })).json().items
      expect(root.scanning).toBe(false)
      expect((await call({ method: 'POST', url: `/api/v1/admin/library/roots/${root.id}/scan`, headers: admin })).json()).toEqual({ queued: true })
      expect((await call({ method: 'POST', url: `/api/v1/admin/library/roots/${root.id}/scan`, headers: admin })).json()).toEqual({ queued: false })
      expect((await call({ url: '/api/v1/admin/library/roots', headers: admin })).json().items[0].scanning).toBe(true)
    } finally {
      await stopJobs()
      await libraryModule.jobs!(jobs)
      await startJobs({ work: true })
    }
    await drainJobs()
    expect((await call({ url: '/api/v1/admin/library/roots', headers: admin })).json().items[0].scanning).toBe(false)
  })
})
