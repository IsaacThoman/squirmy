import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { organizeModule } from './index.js'
import { addAlbum, makeRoot, manifest } from './test-library.js'

describe('organize routes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  const call = (options: InjectOptions) => app.inject(options)

  beforeAll(async () => {
    await organizeModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    admin = { authorization: `Bearer ${setup.json().token}` }
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  it('previews, applies and undoes a batch through jobs', async () => {
    const root = await makeRoot()
    const artist = await createArtist({ name: 'Route Artist' })
    const album = await addAlbum(root, { artist, title: 'Routes', year: 2020, tracks: [{ title: 'A' }, { title: 'B' }] }, ['in/a.flac', 'in/b.flac'])
    const before = await manifest(root.path)

    const preview = await call({ method: 'POST', url: '/api/v1/admin/organize/preview', headers: admin, payload: { rootId: root.id } })
    expect(preview.statusCode).toBe(201)
    const batch = preview.json()
    expect(batch).toMatchObject({ status: 'planned', rootId: root.id, writeTags: false, notice: null, counts: { planned: 2, applied: 0 } })
    expect(batch.albums).toEqual([{
      albumId: album.albumId,
      title: 'Routes',
      artistCredit: 'Route Artist',
      moves: [
        expect.objectContaining({ kind: 'audio', from: 'in/a.flac', to: 'Route Artist/Routes (2020)/01 A.flac', status: 'planned', reason: null }),
        expect.objectContaining({ kind: 'audio', from: 'in/b.flac', to: 'Route Artist/Routes (2020)/02 B.flac', status: 'planned', reason: null }),
      ],
    }])

    const applying = await call({ method: 'POST', url: `/api/v1/admin/organize/batches/${batch.id}/apply`, headers: admin })
    expect(applying.statusCode).toBe(202)
    expect(applying.json().status).toBe('applying')
    await drainJobs()
    const applied = await call({ url: `/api/v1/admin/organize/batches/${batch.id}`, headers: admin })
    expect(applied.json()).toMatchObject({ status: 'applied', counts: { applied: 2 } })
    expect(Object.keys(await manifest(root.path))).toContain('Route Artist/Routes (2020)/01 A.flac')

    const again = await call({ method: 'POST', url: `/api/v1/admin/organize/batches/${batch.id}/apply`, headers: admin })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('batch_not_planned')

    const reverting = await call({ method: 'POST', url: `/api/v1/admin/organize/batches/${batch.id}/revert`, headers: admin })
    expect(reverting.statusCode).toBe(202)
    await drainJobs()
    expect((await call({ url: `/api/v1/admin/organize/batches/${batch.id}`, headers: admin })).json()).toMatchObject({ status: 'reverted', counts: { reverted: 2 } })
    expect(await manifest(root.path)).toEqual(before)

    const list = await call({ url: `/api/v1/admin/organize/batches?rootId=${root.id}&limit=1`, headers: admin })
    expect(list.json()).toMatchObject({ items: [{ id: batch.id, status: 'reverted' }], nextCursor: null })
  })

  it('validates input and requires an admin', async () => {
    const root = await makeRoot('read_only')
    expect((await call({ method: 'POST', url: '/api/v1/admin/organize/preview', payload: { rootId: root.id } })).statusCode).toBe(401)
    const readOnly = await call({ method: 'POST', url: '/api/v1/admin/organize/preview', headers: admin, payload: { rootId: root.id } })
    expect(readOnly.statusCode).toBe(400)
    expect(readOnly.json().error.code).toBe('root_not_managed')
    expect((await call({ method: 'POST', url: '/api/v1/admin/organize/preview', headers: admin, payload: { rootId: 'nope' } })).statusCode).toBe(400)
    expect((await call({ url: '/api/v1/admin/organize/batches/01a1f9ca-9a52-738e-aa0c-db7e00d9bfa0', headers: admin })).statusCode).toBe(404)
    expect((await call({ url: '/api/v1/admin/organize/batches?cursor=nope', headers: admin })).statusCode).toBe(400)
  })
})
