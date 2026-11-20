import { mkdir, mkdtemp, readdir, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Import, ImportFilesResponse, ImportList } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { imports } from '../../database/schema.js'
import { startJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { insertRoot } from '../library/roots.js'
import { sweepImports } from './index.js'
import { stagingDir, stagingRoot } from './staging.js'

type Part = { relativePath?: string; name: string; data: Buffer }

/** A multipart body as a browser would send it: an optional `relativePath` field before each file. */
async function multipart(parts: Part[]) {
  const form = new FormData()
  for (const part of parts) {
    if (part.relativePath !== undefined) form.append('relativePath', part.relativePath)
    form.append('file', new Blob([new Uint8Array(part.data)]), part.name)
  }
  const encoded = new Response(form)
  return { payload: Buffer.from(await encoded.arrayBuffer()), headers: { 'content-type': encoded.headers.get('content-type')! } }
}

const tree = async (dir: string) => (await readdir(dir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

describe('imports API', () => {
  useTestDatabase()
  let app: FastifyInstance
  let tone: Buffer
  let admin: Awaited<ReturnType<typeof signIn>>
  let uploader: Awaited<ReturnType<typeof signIn>>
  let otherUploader: Awaited<ReturnType<typeof signIn>>
  let member: Awaited<ReturnType<typeof signIn>>

  const create = async (who = uploader) => body(await app.inject({ method: 'POST', url: '/api/v1/imports', headers: who.headers, payload: {} }), Import, 201)
  const upload = async (id: string, parts: Part[], who = uploader) => {
    const { payload, headers } = await multipart(parts)
    return app.inject({ method: 'POST', url: `/api/v1/imports/${id}/files`, headers: { ...who.headers, ...headers }, payload })
  }

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const fixtures = await mkdtemp(path.join(tmpdir(), 'squirmy-upload-'))
    tone = await readFile(await makeTone(fixtures, { path: 'tone.flac', durationSec: 1 }))
    admin = await signIn({ role: 'admin' })
    uploader = await signIn({ canUpload: true })
    otherUploader = await signIn({ canUpload: true })
    member = await signIn()
  })

  afterAll(async () => {
    await app.close()
  })

  it('needs a managed root, and says so with a stable code', async () => {
    expect(errorCode(await app.inject({ method: 'POST', url: '/api/v1/imports', headers: uploader.headers, payload: {} }), 409)).toBe('no_managed_root')
    await insertRoot({ name: 'Read only', path: await mkdtemp(path.join(tmpdir(), 'squirmy-ro-')), mode: 'read_only', watch: false })
    expect(errorCode(await app.inject({ method: 'POST', url: '/api/v1/imports', headers: uploader.headers, payload: {} }), 409)).toBe('no_managed_root')
    const first = await insertRoot({ name: 'Managed', path: await mkdtemp(path.join(tmpdir(), 'squirmy-managed-')), mode: 'managed', watch: false })
    expect((await create()).targetRootId).toBe(first.id)

    const second = await insertRoot({ name: 'Second', path: await mkdtemp(path.join(tmpdir(), 'squirmy-managed-')), mode: 'managed', watch: false })
    expect(errorCode(await app.inject({ method: 'POST', url: '/api/v1/imports', headers: uploader.headers, payload: {} }), 409)).toBe('import_root_not_set')
    const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin.headers, payload })
    const readOnly = (await db.query.libraryRoots.findFirst({ where: (roots, { eq }) => eq(roots.mode, 'read_only') }))!
    expect(errorCode(await patch({ importRootId: readOnly.id }), 400)).toBe('import_root_not_managed')
    expect((await patch({ importRootId: second.id })).statusCode).toBe(200)
    expect((await create()).targetRootId).toBe(second.id)
    await updateServerSettings({ importRootId: first.id })
  })

  it('lets only uploaders and admins in, and only to their own imports', async () => {
    expect(errorCode(await app.inject({ method: 'POST', url: '/api/v1/imports', headers: member.headers, payload: {} }), 403)).toBe('upload_not_allowed')
    expect(errorCode(await app.inject({ method: 'GET', url: '/api/v1/imports' }), 401)).toBe('unauthorized')
    const mine = await create()
    expect(errorCode(await app.inject({ url: `/api/v1/imports/${mine.id}`, headers: otherUploader.headers }), 404)).toBe('import_not_found')
    expect(errorCode(await upload(mine.id, [{ name: 'a.flac', data: tone }], otherUploader), 404)).toBe('import_not_found')
    expect(errorCode(await app.inject({ method: 'DELETE', url: `/api/v1/imports/${mine.id}`, headers: otherUploader.headers }), 404)).toBe('import_not_found')
    expect(body(await app.inject({ url: `/api/v1/imports/${mine.id}`, headers: admin.headers }), Import).id).toBe(mine.id)

    const theirs = await create(otherUploader)
    const own = body(await app.inject({ url: '/api/v1/imports?limit=200', headers: uploader.headers }), ImportList)
    expect(own.items.every((item) => item.userId === uploader.id)).toBe(true)
    const all = body(await app.inject({ url: '/api/v1/imports?limit=200', headers: admin.headers }), ImportList)
    expect(all.items.map((item) => item.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]))
    const firstPage = body(await app.inject({ url: '/api/v1/imports?limit=1', headers: admin.headers }), ImportList)
    expect(firstPage.items).toHaveLength(1)
    const secondPage = body(await app.inject({ url: `/api/v1/imports?limit=1&cursor=${firstPage.nextCursor}`, headers: admin.headers }), ImportList)
    expect(secondPage.items[0]!.id < firstPage.items[0]!.id).toBe(true)
  })

  it('receives loose files and a dropped folder, keeping its structure', async () => {
    const created = await create()
    const loose = body(await upload(created.id, [
      { name: '01 One.flac', data: tone },
      { name: 'cover.jpg', data: Buffer.from('jpeg') },
      { name: 'notes.txt', data: Buffer.from('text') },
      { name: '.DS_Store', data: Buffer.from('mac') },
    ]), ImportFilesResponse)
    expect(loose.files.map((file) => [file.path, file.status, file.reason])).toEqual([
      ['01 One.flac', 'accepted', null], ['cover.jpg', 'accepted', null], ['notes.txt', 'rejected', 'unsupported_type'], ['.DS_Store', 'rejected', 'hidden'],
    ])
    const folder = body(await upload(created.id, [
      { relativePath: 'Album/CD1/01 Song.flac', name: '01 Song.flac', data: tone },
      { relativePath: 'Album\\CD2\\01 Song.flac', name: '01 Song.flac', data: tone },
      { relativePath: 'Album/folder.png', name: 'folder.png', data: Buffer.from('png') },
      { relativePath: 'Album/CD1/01 Song.flac', name: '01 Song.flac', data: tone },
    ]), ImportFilesResponse)
    expect(folder.files.map((file) => file.status)).toEqual(['accepted', 'accepted', 'accepted', 'rejected'])
    expect(folder.files[3]!.reason).toBe('duplicate_name')
    expect(await tree(stagingDir(created.id))).toEqual(['01 One.flac', 'Album/CD1/01 Song.flac', 'Album/CD2/01 Song.flac', 'Album/folder.png', 'cover.jpg'])
    expect(folder.import.counts).toMatchObject({ filesReceived: 5, bytesReceived: tone.length * 3 + 7, filesRejected: 2 })
  })

  it('never writes outside the staging folder, whatever the names say', async () => {
    const created = await create()
    const response = body(await upload(created.id, [
      { relativePath: '../../escape.flac', name: 'a.flac', data: tone },
      { relativePath: '/etc/escape.flac', name: 'b.flac', data: tone },
      { relativePath: 'Album/../../escape.flac', name: 'c.flac', data: tone },
      { relativePath: 'C:\\escape.flac', name: 'd.flac', data: tone },
      { relativePath: 'bad\u0007name.flac', name: 'e.flac', data: tone },
      // The parser keeps only the base name of a part's filename.
      { name: '../../../escape.flac', data: tone },
    ]), ImportFilesResponse)
    expect(response.files.map((file) => file.reason)).toEqual(['unsafe_path', 'unsafe_path', 'unsafe_path', 'unsafe_path', 'unsafe_path', null])
    expect(await tree(stagingDir(created.id))).toEqual(['escape.flac'])
    expect((await readdir(stagingRoot())).filter((name) => name.includes('escape'))).toEqual([])
  })

  it('enforces the per-file and per-import size limits', async () => {
    await updateServerSettings({ importMaxFileBytes: tone.length + 10, importMaxBytes: tone.length * 2 + 10 })
    const created = await create()
    const tooBig = await upload(created.id, [{ name: 'small.flac', data: tone }, { name: 'big.flac', data: Buffer.concat([tone, tone]) }])
    expect(errorCode(tooBig, 413)).toBe('file_too_large')
    expect((tooBig.json() as { error: { details: { files: unknown[] } } }).error.details.files).toEqual([{ path: 'small.flac', status: 'accepted', reason: null, bytes: tone.length }])
    expect(await tree(stagingDir(created.id))).toEqual(['small.flac'])
    expect(errorCode(await upload(created.id, [{ name: 'second.flac', data: tone }, { name: 'third.flac', data: tone }]), 413)).toBe('import_too_large')
    expect(await tree(stagingDir(created.id))).toEqual(['second.flac', 'small.flac'])
    expect((await readdir(stagingDir(created.id))).some((name) => name.startsWith('.'))).toBe(false)
    expect(body(await app.inject({ url: `/api/v1/imports/${created.id}`, headers: uploader.headers }), Import).counts.bytesReceived).toBe(tone.length * 2)
    await updateServerSettings({ importMaxFileBytes: 4 * 1024 ** 3, importMaxBytes: 64 * 1024 ** 3 })
  })

  it('commits once, then refuses more files and cancelling', async () => {
    const created = await create()
    expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/imports/${created.id}/commit`, headers: uploader.headers }), 400)).toBe('import_empty')
    body(await upload(created.id, [{ name: 'a.flac', data: tone }]), ImportFilesResponse)
    const committed = body(await app.inject({ method: 'POST', url: `/api/v1/imports/${created.id}/commit`, headers: uploader.headers }), Import, 202)
    expect(committed).toMatchObject({ status: 'processing', step: 'extracting' })
    expect(errorCode(await upload(created.id, [{ name: 'b.flac', data: tone }]), 409)).toBe('import_not_receiving')
    expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/imports/${created.id}/commit`, headers: uploader.headers }), 409)).toBe('import_not_receiving')
    expect(errorCode(await app.inject({ method: 'DELETE', url: `/api/v1/imports/${created.id}`, headers: uploader.headers }), 409)).toBe('import_not_receiving')
  })

  it('cancels while receiving and cleans up the staging folder', async () => {
    const created = await create()
    body(await upload(created.id, [{ name: 'a.flac', data: tone }]), ImportFilesResponse)
    const cancelled = body(await app.inject({ method: 'DELETE', url: `/api/v1/imports/${created.id}`, headers: uploader.headers }), Import)
    expect(cancelled).toMatchObject({ status: 'failed', error: 'Cancelled', step: null })
    expect(await readdir(stagingDir(created.id)).catch(() => null)).toBeNull()
  })

  it('expires imports stuck receiving and removes orphaned staging folders', async () => {
    const stuck = await create()
    body(await upload(stuck.id, [{ name: 'a.flac', data: tone }]), ImportFilesResponse)
    const fresh = await create()
    await db.update(imports).set({ updatedAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(imports.id, stuck.id))
    const orphan = stagingDir(newId())
    await mkdir(orphan, { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(orphan, old, old)

    await sweepImports()
    const [expired] = await db.select().from(imports).where(eq(imports.id, stuck.id))
    expect(expired).toMatchObject({ status: 'failed', error: 'Expired: no files arrived for a day' })
    expect(await readdir(stagingDir(stuck.id)).catch(() => null)).toBeNull()
    expect(await readdir(orphan).catch(() => null)).toBeNull()
    expect(await readdir(stagingDir(fresh.id))).toEqual([])
  })
})
