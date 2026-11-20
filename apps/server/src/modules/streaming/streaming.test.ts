import { fstatSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { fileMoves, mediaFiles, organizeBatches, releaseLoudness, users } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { signStreamUrl } from './playback.js'

describe('streaming originals', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: string
  let rootId: string
  let admin: { authorization: string }
  let adminToken = ''
  let memberId = ''
  let flac: { recordingId: string; fileId: string; bytes: Buffer }
  let unowned: string
  let otherAlbum: Awaited<ReturnType<typeof createAlbum>>

  const call = (options: InjectOptions) => app.inject(options)

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    adminToken = setup.json().token
    admin = { authorization: `Bearer ${adminToken}` }
    const member = await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'mira', password: 'mira password' } })
    memberId = member.json().id

    root = await mkdtemp(path.join(tmpdir(), 'squirmy-stream-'))
    rootId = (await createLibraryRoot({ path: root })).id
    const file = await makeTone(root, { path: 'Mira/Blue Hour/01 Night.flac', durationSec: 3, cover: true, tags: { title: 'Night Swimming', artist: 'Mira Vale' } })
    const album = await createAlbum({ owned: true, rootId, tracks: [{ title: 'Night Swimming' }, { title: 'Not On Disk' }] })
    const fileId = album.tracks[0]!.fileId!
    const bytes = await readFile(file)
    await db.update(mediaFiles).set({ relPath: 'Mira/Blue Hour/01 Night.flac', tags: { title: 'Night Swimming', artist: 'Mira Välé' }, size: bytes.length, durationMs: 3000, loudnessLufs: -21, truePeakDb: -6 })
      .where(eq(mediaFiles.id, fileId))
    await db.insert(releaseLoudness).values({ releaseId: album.releaseId, loudnessLufs: -20, truePeakDb: -3, fileCount: 1 })
    flac = { recordingId: album.tracks[0]!.recordingId, fileId, bytes }
    unowned = (await createAlbum({ tracks: [{ title: 'Gray' }] })).tracks[0]!.recordingId
    otherAlbum = album
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    await rm(root, { recursive: true, force: true })
  })

  const descriptor = async (query = '') => {
    const response = await call({ url: `/api/v1/tracks/${flac.recordingId}/playback${query}`, headers: admin })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  it('describes playback with a signed URL', async () => {
    const body = await descriptor()
    expect(body).toMatchObject({
      trackId: flac.recordingId, fileId: flac.fileId, profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac',
      lossless: true, bytes: flac.bytes.length, durationMs: 3000,
      normalization: { trackGainDb: 3, trackPeak: 0.501187, albumGainDb: 2, albumPeak: 0.707946 },
    })
    expect(body.url).toMatch(new RegExp(`^/api/v1/stream/${flac.fileId}\\?exp=\\d+&uid=[0-9a-f-]+&sig=[\\w-]+$`))
    const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(11.9)
    expect(hours).toBeLessThanOrEqual(12)

    const high = await descriptor('?quality=high')
    expect(high).toMatchObject({ profile: 'aac_256', transcoded: true, mime: 'audio/aac', codec: 'aac', lossless: false, bitrate: 256_000, bytes: null })
    expect(high.url).toContain(`/stream/${flac.fileId}/aac_256?`)
    expect((await descriptor('?download=1')).url).toContain('&download=1')
    expect((await descriptor('?download=false')).url).not.toContain('download')

    expect((await call({ url: `/api/v1/tracks/${flac.recordingId}/playback` })).statusCode).toBe(401)
    const missing = await call({ url: `/api/v1/tracks/${unowned}/playback`, headers: admin })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_available')
  })

  it('serves byte-exact ranges', async () => {
    const { url } = await descriptor()
    const size = flac.bytes.length
    const full = await call({ url })
    expect(full.statusCode).toBe(200)
    expect(full.rawPayload.equals(flac.bytes)).toBe(true)
    expect(full.headers).toMatchObject({ 'content-type': 'audio/flac', 'accept-ranges': 'bytes', 'cache-control': 'private', 'content-length': String(size) })
    const etag = full.headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)

    const cases: [string, number, number][] = [
      ['bytes=0-99', 0, 99],
      ['bytes=1000-1999', 1000, 1999],
      ['bytes=-500', size - 500, size - 1],
      [`bytes=${size - 300}-`, size - 300, size - 1],
      [`bytes=10-${size * 10}`, 10, size - 1],
    ]
    for (const [range, start, end] of cases) {
      const response = await call({ url, headers: { range } })
      expect(response.statusCode, range).toBe(206)
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`)
      expect(response.headers['content-length']).toBe(String(end - start + 1))
      expect(response.rawPayload.equals(flac.bytes.subarray(start, end + 1)), range).toBe(true)
    }

    for (const range of [`bytes=${size}-`, 'bytes=-0']) {
      const response = await call({ url, headers: { range } })
      expect(response.statusCode, range).toBe(416)
      expect(response.headers['content-range']).toBe(`bytes */${size}`)
    }
    // Several ranges, or nonsense, are answered with the whole file.
    expect((await call({ url, headers: { range: 'bytes=0-1,5-6' } })).statusCode).toBe(200)
    expect((await call({ url, headers: { range: 'bytes=9-2' } })).statusCode).toBe(200)

    const matching = await call({ url, headers: { range: 'bytes=0-9', 'if-range': etag } })
    expect(matching.statusCode).toBe(206)
    expect(matching.rawPayload.equals(flac.bytes.subarray(0, 10))).toBe(true)
    const byDate = await call({ url, headers: { range: 'bytes=0-9', 'if-range': full.headers['last-modified'] as string } })
    expect(byDate.statusCode).toBe(206)
    const stale = await call({ url, headers: { range: 'bytes=0-9', 'if-range': '"0-0"' } })
    expect(stale.statusCode).toBe(200)
    expect(stale.rawPayload.equals(flac.bytes)).toBe(true)

    const head = await call({ method: 'HEAD', url })
    expect(head.statusCode).toBe(200)
    expect(head.headers['content-length']).toBe(String(size))
    expect(head.rawPayload.length).toBe(0)
    const headRange = await call({ method: 'HEAD', url, headers: { range: 'bytes=0-9' } })
    expect(headRange.statusCode).toBe(206)
    expect(headRange.headers['content-length']).toBe('10')
  })

  it('checks signatures and falls back to the session', async () => {
    const { url } = await descriptor()
    const signed = new URL(url, 'http://x')
    const with_ = (change: (params: URLSearchParams) => void, pathname = signed.pathname) => {
      const params = new URLSearchParams(signed.search)
      change(params)
      return `${pathname}?${params}`
    }
    const status = async (target: string, headers: Record<string, string> = {}) => (await call({ url: target, headers })).statusCode

    expect(await status(url)).toBe(200)
    const sig = signed.searchParams.get('sig')!
    expect(await status(with_((params) => params.set('sig', `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`)))).toBe(403)
    expect(await status(with_((params) => params.set('uid', memberId)))).toBe(403)
    expect(await status(with_((params) => params.set('exp', String(Number(params.get('exp')) + 60))))).toBe(403)
    expect(await status(with_(() => {}, `${signed.pathname}/mp3_192`))).toBe(403)
    const expired = signStreamUrl(flac.fileId, 'original', memberId, { now: Date.now() - 13 * 3_600_000 })
    expect(await status(expired.url)).toBe(403)
    expect(await status(signStreamUrl(flac.fileId, 'original', memberId).url)).toBe(200)
    expect((await call({ url: signed.pathname })).json().error.code).toBe('unauthorized')

    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, memberId))
    expect(await status(signStreamUrl(flac.fileId, 'original', memberId).url)).toBe(403)
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, memberId))

    expect(await status(signed.pathname, admin)).toBe(200)
    expect(await status(signed.pathname, { cookie: `squirmy_session=${adminToken}` })).toBe(200)
    expect(await status(expired.url, admin)).toBe(200)
    expect(await status(`${signed.pathname}/original`, admin)).toBe(200)
    expect(await status(`${signed.pathname}/flac_9000`, admin)).toBe(404)
  })

  it('marks downloads as attachments', async () => {
    const { url } = await descriptor('?download=1')
    const response = await call({ url })
    expect(response.headers['content-disposition']).toBe(`attachment; filename="Mira Vale - Night Swimming.flac"; filename*=UTF-8''Mira%20V%C3%A4l%C3%A9%20-%20Night%20Swimming.flac`)
  })

  it('refuses paths outside the root and marks vanished files missing', async () => {
    const fileId = otherAlbum.tracks[1]!.fileId!
    const outside = await makeTone(path.dirname(root), { path: `${path.basename(root)}-outside.flac` })
    await db.update(mediaFiles).set({ relPath: `../${path.basename(outside)}` }).where(eq(mediaFiles.id, fileId))
    const escaped = await call({ url: `/api/v1/stream/${fileId}`, headers: admin })
    expect(escaped.statusCode).toBe(403)
    expect(escaped.json().error.code).toBe('path_outside_root')
    await rm(outside)

    await db.update(mediaFiles).set({ relPath: 'Mira/Blue Hour/02 Gone.flac' }).where(eq(mediaFiles.id, fileId))
    const gone = await call({ url: `/api/v1/stream/${fileId}`, headers: admin })
    expect(gone.statusCode).toBe(404)
    expect(gone.json().error.code).toBe('file_missing')
    const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
    expect(row!.missingSince).toBeInstanceOf(Date)
  })

  it('keeps serving a file that organize is moving, at either end of the move', async () => {
    const from = 'Mira/Blue Hour/01 Night.flac'
    const to = 'Mira Vale/Blue Hour (2024)/01 Night Swimming.flac'
    const [batch] = await db.insert(organizeBatches).values({ id: newId(), rootId, status: 'applying' }).returning()
    await db.insert(fileMoves).values({ id: newId(), batchId: batch!.id, fileId: flac.fileId, fromRelPath: from, toRelPath: to })
    // Organize renames on disk first and updates the row after.
    await mkdir(path.dirname(path.join(root, to)), { recursive: true })
    await rename(path.join(root, from), path.join(root, to))
    try {
      const { url } = signStreamUrl(flac.fileId, 'original', memberId)
      const response = await call({ url, headers: { range: 'bytes=0-99' } })
      expect(response.statusCode).toBe(206)
      expect(response.rawPayload).toEqual(flac.bytes.subarray(0, 100))
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, flac.fileId))
      expect(row).toMatchObject({ relPath: from, missingSince: null })
    } finally {
      await rename(path.join(root, to), path.join(root, from))
      await db.delete(organizeBatches).where(eq(organizeBatches.id, batch!.id))
    }
  })

  it('closes the file when a client goes away', async () => {
    const big = await makeTone(root, { path: 'Mira/Long/01 Long.wav', durationSec: 60 })
    const fileId = otherAlbum.tracks[1]!.fileId!
    await db.update(mediaFiles).set({ relPath: 'Mira/Long/01 Long.wav', missingSince: null }).where(eq(mediaFiles.id, fileId))
    expect((await stat(big)).size).toBeGreaterThan(5_000_000)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    const { url } = signStreamUrl(fileId, 'original', memberId)
    // Regular files only: sockets and the database pool come and go on their own.
    const openFiles = () => readdirSync('/dev/fd').filter((fd) => {
      try {
        return fstatSync(Number(fd)).isFile()
      } catch {
        return false
      }
    }).length
    const before = openFiles()
    await Promise.all(Array.from({ length: 5 }, () => new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}${url}`, (response) => {
        response.once('data', () => {
          request.destroy()
          resolve()
        })
      })
      request.on('error', (error) => (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(error))
    })))
    await expect.poll(openFiles, { timeout: 5000 }).toBeLessThanOrEqual(before)
  })
})
