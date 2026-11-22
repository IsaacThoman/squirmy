import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { StreamProfile } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { mediaFiles, transcodes } from '../../database/schema.js'
import { enqueue, getQueueStats, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot, createUser } from '../../test/factories.js'
import { evictTranscodes } from './cache.js'
import { streamingModule } from './index.js'
import { signStreamUrl } from './playback.js'
import { cacheRoot } from './transcode.js'

const spawned = vi.hoisted(() => ({ ffmpeg: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    spawned.ffmpeg++
    return actual.spawn(...args)
  }) as typeof actual.spawn
  return { ...actual, spawn }
})

const run = promisify(execFile)

type Probe = { streams: { codec_type: string; codec_name: string }[]; format: { format_name: string; tags?: Record<string, string> } }

/** Seconds of audio, by decoding: ADTS has no index, so ffprobe only estimates its duration. */
async function decodedSeconds(file: string): Promise<number> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return stdout.length / 16_000
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-of', 'json', '-show_entries', 'format=format_name:format_tags:stream=codec_type,codec_name', file])
  return JSON.parse(stdout) as Probe
}

describe('transcodes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: string
  let scratch: string
  let userId = ''

  /**
   * A library file row for `source`. Rows must have distinct paths, so a source that exists
   * is copied under a fresh name; pass `copy: false` to point at the path itself.
   */
  async function addFile(source: string, { copy = true } = {}) {
    const { rootId, tracks: [track] } = await createAlbum({ owned: true, rootId: (await rootRow()).id, tracks: [{ title: 'Signal' }] })
    const relPath = copy ? `copies/${newId()}${path.extname(source)}` : source
    if (copy) {
      await mkdir(path.join(root, 'copies'), { recursive: true })
      await copyFile(path.join(root, source), path.join(root, relPath))
    }
    const size = (await stat(path.join(root, relPath)).catch(() => ({ size: 0 }))).size
    const [row] = await db.update(mediaFiles).set({
      rootId: rootId!, relPath, size, durationMs: 3000, tags: { title: 'Signal', artist: 'Mira Vale', album: 'Blue Hour', track: 1 },
    }).where(eq(mediaFiles.id, track!.fileId!)).returning()
    return row!
  }
  let rootCache: { id: string } | undefined
  const rootRow = async () => rootCache ??= await createLibraryRoot({ path: root })

  const fetch = (fileId: string, profile: StreamProfile, headers: Record<string, string> = {}) =>
    app.inject({ url: signStreamUrl(fileId, profile, userId).url, headers })

  const row = async (fileId: string, profile: string) =>
    (await db.select().from(transcodes).where(and(eq(transcodes.fileId, fileId), eq(transcodes.profile, profile))))[0]

  beforeAll(async () => {
    await streamingModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
    userId = (await createUser()).id
    root = await mkdtemp(path.join(tmpdir(), 'squirmy-transcode-'))
    scratch = await mkdtemp(path.join(tmpdir(), 'squirmy-transcode-out-'))
    await makeTone(root, { path: 'a/tone.flac', durationSec: 3, cover: true })
    await makeTone(root, { path: 'a/long.flac', durationSec: 20 })
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    await rm(root, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  const expectations: [StreamProfile, string, string, string][] = [
    ['aac_256', 'aac', 'aac', 'audio/aac'],
    ['opus_128', 'opus', 'ogg', 'audio/ogg'],
    ['mp3_320', 'mp3', 'mp3', 'audio/mpeg'],
    ['mp3_192', 'mp3', 'mp3', 'audio/mpeg'],
  ]

  it.each(expectations)('encodes %s while streaming, then serves the cached file with Range', async (profile, codec, format, mime) => {
    const file = await addFile('a/tone.flac')
    const first = await fetch(file.id, profile, { range: 'bytes=0-' })
    expect(first.statusCode).toBe(200)
    expect(first.headers).toMatchObject({ 'content-type': mime, 'accept-ranges': 'none', 'cache-control': 'private' })
    expect(first.headers['content-length']).toBeUndefined()

    const output = path.join(scratch, `${profile}.out`)
    await writeFile(output, first.rawPayload)
    const info = await probe(output)
    expect(info.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([['audio', codec]])
    expect(info.format.format_name).toBe(format)
    expect(await decodedSeconds(output)).toBeCloseTo(3, 1)
    const tags = Object.fromEntries(Object.entries(info.format.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    if (profile !== 'opus_128') expect(tags).toMatchObject({ title: 'Signal', artist: 'Mira Vale' })

    const cached = await row(file.id, profile)
    expect(cached).toMatchObject({ status: 'ready', bytes: first.rawPayload.length })
    expect((await readFile(path.join(cacheRoot(), cached!.storagePath))).equals(first.rawPayload)).toBe(true)

    const ranged = await fetch(file.id, profile, { range: 'bytes=100-199' })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers).toMatchObject({ 'accept-ranges': 'bytes', 'content-type': mime, 'content-range': `bytes 100-199/${first.rawPayload.length}` })
    expect(ranged.rawPayload.equals(first.rawPayload.subarray(100, 200))).toBe(true)
  })

  it('encodes again when the source file is replaced', async () => {
    const file = await addFile('a/tone.flac')
    const first = await fetch(file.id, 'mp3_192')
    await writeFile(path.join(scratch, 'before.mp3'), first.rawPayload)
    expect(await decodedSeconds(path.join(scratch, 'before.mp3'))).toBeCloseTo(3, 1)
    expect(await row(file.id, 'mp3_192')).toMatchObject({ status: 'ready' })

    // A different recording copied over the same path; the scanner records its new size and mtime.
    await copyFile(path.join(root, 'a/long.flac'), path.join(root, file.relPath))
    const info = await stat(path.join(root, file.relPath))
    await db.update(mediaFiles).set({ size: info.size, mtime: new Date(Math.floor(info.mtimeMs)) }).where(eq(mediaFiles.id, file.id))

    const second = await fetch(file.id, 'mp3_192')
    expect(second.statusCode).toBe(200)
    await writeFile(path.join(scratch, 'after.mp3'), second.rawPayload)
    expect(await decodedSeconds(path.join(scratch, 'after.mp3'))).toBeCloseTo(20, 1)
    const ready = await row(file.id, 'mp3_192')
    expect(ready).toMatchObject({ status: 'ready', bytes: second.rawPayload.length })
    expect((await fetch(file.id, 'mp3_192', { range: 'bytes=0-9' })).rawPayload.equals(second.rawPayload.subarray(0, 10))).toBe(true)
  })

  it('keeps tags in Ogg Opus and drops the picture', async () => {
    const file = await addFile('a/tone.flac')
    const response = await fetch(file.id, 'opus_128')
    const output = path.join(scratch, 'tags.opus')
    await writeFile(output, response.rawPayload)
    const { stdout } = await run('ffprobe', ['-v', 'error', '-of', 'json', '-show_entries', 'stream=codec_type:stream_tags', output])
    const streams = JSON.parse(stdout).streams as { codec_type: string; tags: Record<string, string> }[]
    expect(streams).toHaveLength(1)
    expect(streams[0]!.tags).toMatchObject({ title: 'Signal', artist: 'Mira Vale', album: 'Blue Hour' })
  })

  it('shares one encoder between simultaneous first requests', async () => {
    const file = await addFile('a/long.flac')
    const before = spawned.ffmpeg
    const [one, two] = await Promise.all([fetch(file.id, 'mp3_192'), fetch(file.id, 'mp3_192')])
    expect(spawned.ffmpeg - before).toBe(1)
    expect(one!.statusCode).toBe(200)
    expect(one!.rawPayload.equals(two!.rawPayload)).toBe(true)
    expect(one!.rawPayload.length).toBeGreaterThan(400_000)
  })

  it('finishes the cache file when the client goes away', async () => {
    const file = await addFile('a/long.flac')
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as AddressInfo
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}${signStreamUrl(file.id, 'aac_256', userId).url}`, (response) => {
        response.once('data', () => {
          request.destroy()
          resolve()
        })
      })
      request.on('error', (error) => (error as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve() : reject(error))
    })
    await expect.poll(async () => (await row(file.id, 'aac_256'))?.status, { timeout: 10_000 }).toBe('ready')
    const ready = await row(file.id, 'aac_256')
    expect(await decodedSeconds(path.join(cacheRoot(), ready!.storagePath))).toBeCloseTo(20, 1)
  })

  it('cleans up after a failed encode and retries on the next request', async () => {
    await mkdir(path.join(root, 'b'), { recursive: true })
    await writeFile(path.join(root, 'b/broken.flac'), Buffer.alloc(4096, 7))
    const file = await addFile('b/broken.flac', { copy: false })
    const failed = await fetch(file.id, 'opus_128')
    expect(failed.statusCode).toBe(500)
    expect(failed.json().error.code).toBe('transcode_failed')
    expect(await row(file.id, 'opus_128')).toMatchObject({ status: 'failed' })
    expect(await readdir(path.join(cacheRoot(), file.id))).toEqual([])

    await makeTone(root, { path: 'b/broken.flac', durationSec: 1 })
    const retried = await fetch(file.id, 'opus_128')
    expect(retried.statusCode).toBe(200)
    expect(await row(file.id, 'opus_128')).toMatchObject({ status: 'ready', error: null })
  })

  it('answers HEAD without encoding and 404s a vanished source', async () => {
    const file = await addFile('a/tone.flac')
    const before = spawned.ffmpeg
    const head = await app.inject({ method: 'HEAD', url: signStreamUrl(file.id, 'mp3_320', userId).url })
    expect(head.statusCode).toBe(200)
    expect(head.headers['accept-ranges']).toBe('none')
    expect(spawned.ffmpeg).toBe(before)

    const gone = await addFile('a/gone.flac', { copy: false })
    const response = await fetch(gone.id, 'aac_256')
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('file_missing')
  })

  it('drops the queue of the removed streaming.transcode job at worker start', async () => {
    // What a server that ran an older version still has.
    await enqueue('streaming.transcode', { fileId: newId(), profile: 'aac_256' })
    expect((await getQueueStats()).map((queue) => queue.name)).toContain('streaming.transcode')
    await streamingModule.start!({ role: 'worker' })
    expect((await getQueueStats()).map((queue) => queue.name)).not.toContain('streaming.transcode')
    await streamingModule.start!({ role: 'worker' })
  })

  it('evicts least recently used transcodes beyond the cap and reconciles with the disk', async () => {
    await db.delete(transcodes)
    await rm(cacheRoot(), { recursive: true, force: true })
    const file = await addFile('a/tone.flac')
    const put = async (profile: string, bytes: number, minutesAgo: number, onDisk = true) => {
      const storagePath = `${file.id}/${profile}.bin`
      if (onDisk) {
        await mkdir(path.join(cacheRoot(), file.id), { recursive: true })
        await writeFile(path.join(cacheRoot(), storagePath), Buffer.alloc(bytes))
      }
      await db.insert(transcodes).values({ id: newId(), fileId: file.id, profile, storagePath, bytes, status: 'ready', lastUsedAt: new Date(Date.now() - minutesAgo * 60_000) })
    }
    await put('oldest', 1000, 180)
    await put('middle', 1000, 150)
    await put('newest', 1000, 120)
    await put('vanished', 1000, 5, false)
    const orphan = path.join(cacheRoot(), file.id, 'orphan.aac')
    const fresh = path.join(cacheRoot(), file.id, '.aac_256.abc.part')
    await writeFile(orphan, 'x')
    await writeFile(fresh, 'x')
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(orphan, hourAgo, hourAgo)
    await db.insert(transcodes).values({ id: newId(), fileId: file.id, profile: 'abandoned', storagePath: 'x', status: 'pending', lastUsedAt: hourAgo })

    await updateServerSettings({ transcodeCacheMaxBytes: 2000 })
    await evictTranscodes()
    const left = await db.select({ profile: transcodes.profile }).from(transcodes)
    expect(left.map((entry) => entry.profile).sort()).toEqual(['middle', 'newest'])
    expect((await readdir(path.join(cacheRoot(), file.id))).sort()).toEqual(['.aac_256.abc.part', 'middle.bin', 'newest.bin'])

    // Someone is listening to this one: a seek or the next Range request must still find it.
    await put('playing', 1000, 2)
    await updateServerSettings({ transcodeCacheMaxBytes: 0 })
    await rm(fresh)
    await evictTranscodes()
    expect((await db.select({ profile: transcodes.profile }).from(transcodes)).map((entry) => entry.profile)).toEqual(['playing'])
    expect(await readdir(path.join(cacheRoot(), file.id))).toEqual(['playing.bin'])

    await db.update(transcodes).set({ lastUsedAt: hourAgo })
    await evictTranscodes()
    expect(await db.select().from(transcodes)).toEqual([])
    expect(await readdir(cacheRoot())).toEqual([])
  })
})
