import { execFile, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { StreamIntent, StreamProfile } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { mediaFiles, transcodes } from '../../database/schema.js'
import { enqueue, getQueueStats, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeTone, writeHostileInputs } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot, createUser } from '../../test/factories.js'
import { evictTranscodes } from './cache.js'
import { streamingModule } from './index.js'
import { signStreamUrl } from './playback.js'
import { cacheRoot, isTranscoding, setTranscodeSlotLimit, stopTranscodes, tryAcquireSlot } from './transcode.js'

type Encoder = { child: ChildProcess; input: string; exited: boolean; encodedMs: number }
const spawned = vi.hoisted(() => ({ ffmpeg: 0, slow: false, encoders: [] as Encoder[], peak: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    spawned.ffmpeg++
    const command = args[1]
    if (!spawned.slow || !Array.isArray(command) || !command.includes('-progress')) return actual.spawn(...args)
    const inputIndex = command.indexOf('-i')
    const input = command[inputIndex + 1]!
    const slow = [...command.slice(0, inputIndex), '-readrate', '0.25', ...command.slice(inputIndex, -1), '-flush_packets', '1', 'pipe:1']
    const child = actual.spawn(args[0], slow, args[2])
    const encoder = { child, input, exited: false, encodedMs: 0 }
    spawned.encoders.push(encoder)
    spawned.peak = Math.max(spawned.peak, spawned.encoders.filter(({ exited }) => !exited).length)
    child.once('close', () => { encoder.exited = true })
    createInterface({ input: child.stderr! }).on('line', (line) => {
      if (line.startsWith('out_time_us=')) encoder.encodedMs = Number(line.slice('out_time_us='.length)) / 1000
    })
    return child
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
  async function addFile(source: string, { copy = true, durationMs = 3000 } = {}) {
    const { rootId, tracks: [track] } = await createAlbum({ owned: true, rootId: (await rootRow()).id, tracks: [{ title: 'Signal' }] })
    const relPath = copy ? `copies/${newId()}${path.extname(source)}` : source
    if (copy) {
      await mkdir(path.join(root, 'copies'), { recursive: true })
      await copyFile(path.join(root, source), path.join(root, relPath))
    }
    const size = (await stat(path.join(root, relPath)).catch(() => ({ size: 0 }))).size
    const [row] = await db.update(mediaFiles).set({
      rootId: rootId!, relPath, size, durationMs, tags: { title: 'Signal', artist: 'Mira Vale', album: 'Blue Hour', track: 1 },
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

  it('refuses a file whose content makes ffmpeg read another file', async () => {
    await makeTone(root, { path: 'h/real.flac', durationSec: 1 })
    await writeHostileInputs(path.join(root, 'h'), { target: 'real.flac', url: 'http://127.0.0.1:9' })
    const file = await addFile('h/concat.flac', { copy: false })
    const response = await fetch(file.id, 'opus_128')
    expect(response.statusCode).toBe(500)
    expect(response.json().error.code).toBe('transcode_failed')
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

  describe('encoder scheduling over HTTP', () => {
    const profile = 'aac_256'
    const requests: http.ClientRequest[] = []
    type Source = Awaited<ReturnType<typeof addFile>>
    const addLong = () => addFile('a/long.flac', { durationMs: 20_000 })

    beforeAll(async () => {
      if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' })
    })

    beforeEach(() => {
      spawned.slow = true
      spawned.encoders = []
      spawned.peak = 0
      setTranscodeSlotLimit(2)
    })

    afterEach(async () => {
      for (const request of requests.splice(0)) request.destroy()
      await stopTranscodes()
      setTranscodeSlotLimit(null)
      spawned.slow = false
    })

    function connect(file: Source, intent?: StreamIntent, user = userId) {
      const { port } = app.server.address() as AddressInfo
      const url = signStreamUrl(file.id, profile, user).url
      const request = http.get(`http://127.0.0.1:${port}${url}${intent ? `&intent=${intent}` : ''}`)
      requests.push(request)
      const firstByte = new Promise<number | undefined>((resolve) => {
        request.on('error', () => resolve(undefined))
        request.once('response', (response) => {
          response.on('error', () => resolve(undefined))
          response.once('data', () => resolve(response.statusCode === 200 ? performance.now() : undefined))
          response.resume()
        })
      })
      return { request, firstByte }
    }

    const started = (file: Source) => vi.waitFor(() => {
      const encoder = spawned.encoders.findLast(({ input }) => input.endsWith(file.relPath))
      if (!encoder) throw new Error(`Encoder did not start for ${file.relPath}`)
      return encoder
    })

    async function queue(file: Source, intent: StreamIntent) {
      const client = connect(file, intent)
      await expect.poll(() => isTranscoding(file.id, profile)).toBe(true)
      return client
    }

    it('runs ten rapid skips in two slots and starts the final play promptly', async () => {
      const files = []
      for (let index = 0; index < 10; index++) files.push(await addLong())
      let previous: ReturnType<typeof connect> | undefined
      let idleStartupMs = 0
      for (const [index, file] of files.entries()) {
        const time = performance.now()
        previous?.request.destroy()
        previous = connect(file)
        if (index === 0) {
          const first = await previous.firstByte
          expect(first).toBeDefined()
          idleStartupMs = first! - time
        }
        if (index === files.length - 1) {
          const last = await previous.firstByte
          expect(last).toBeDefined()
          expect(last! - time).toBeLessThan(idleStartupMs + 500)
        } else {
          await started(file)
          await delay(Math.max(0, 1000 - (performance.now() - time)))
        }
      }
      expect(spawned.encoders).toHaveLength(10)
      expect(spawned.peak).toBe(2)
    }, 15_000)

    it('orders the queue by intent then arrival and removes closed requests before they spawn', async () => {
      const holders = [await addLong(), await addLong()]
      for (const file of holders) {
        connect(file)
        await started(file)
      }
      const queued: Source[] = []
      for (const intent of ['download', 'cache', 'next', 'next', 'play'] as const) {
        const file = await addLong()
        await queue(file, intent)
        queued.push(file)
      }
      const abandoned = await addLong()
      const { request } = await queue(abandoned, 'play')
      request.destroy()
      await expect.poll(() => isTranscoding(abandoned.id, profile)).toBe(false)
      expect(spawned.encoders).toHaveLength(2)

      let encoder = await started(holders[0]!)
      for (const index of [4, 2, 3, 1, 0]) {
        encoder.child.kill('SIGKILL')
        const file = queued[index]!
        encoder = await started(file)
        expect(spawned.encoders.at(-1)).toBe(encoder)
      }
      expect(spawned.peak).toBe(2)
    })

    it('preempts a download for playback and keeps the cache encode shared with a player', async () => {
      const cache = await addLong()
      const download = await addLong()
      const play = await addLong()
      await connect(cache, 'cache').firstByte
      const shared = connect(cache, 'play')
      expect(await shared.firstByte).toBeDefined()
      connect(download, 'download')
      const victim = await started(download)
      connect(play)
      const playing = await started(play)
      expect(victim.exited).toBe(true)
      expect(await row(download.id, profile)).toBeUndefined()
      expect(await readdir(path.join(cacheRoot(), download.id))).toEqual([])
      expect((await started(cache)).exited).toBe(false)
      expect(spawned.encoders).toHaveLength(3)
      expect(spawned.peak).toBe(2)

      const anotherPlay = await addLong()
      const waiting = await queue(anotherPlay, 'play')
      expect(spawned.encoders).toHaveLength(3)
      waiting.request.destroy()
      await expect.poll(() => isTranscoding(anotherPlay.id, profile)).toBe(false)
      playing.child.kill('SIGKILL')
      const retried = connect(download, 'download')
      expect(await retried.firstByte).toBeDefined()
      expect(spawned.encoders.filter(({ input }) => input.endsWith(download.relPath))).toHaveLength(2)
    })

    it('cancels only the abandoned early play after ten seconds', async () => {
      setTranscodeSlotLimit(5)
      const play = await addLong()
      const shared = await addLong()
      const cache = await addLong()
      const download = await addLong()
      const halfway = await addFile('a/tone.flac')
      const other = await createUser({ username: 'another-listener' })
      const first = connect(play)
      const second = connect(shared)
      const stillListening = connect(shared)
      const prefetch = connect(cache, 'cache')
      const saving = connect(download, 'download')
      const nearEnd = connect(halfway, 'play', other.id)
      expect(await Promise.all([first, second, stillListening, prefetch, saving, nearEnd].map((client) => client.firstByte)))
        .toEqual(Array.from({ length: 6 }, () => expect.any(Number)))

      const end = await started(halfway)
      await expect.poll(() => end.encodedMs, { timeout: 9000 }).toBeGreaterThanOrEqual(1500)
      // Hold it past the grace interval to prove that the elapsed audio, rather than process
      // completion, protects the result.
      end.child.kill('SIGSTOP')
      const disconnectedAt = performance.now()
      for (const client of [first, second, prefetch, saving, nearEnd]) client.request.destroy()
      expect((await started(play)).exited).toBe(false)
      await expect.poll(() => isTranscoding(play.id, profile), { timeout: 11_000 }).toBe(false)
      expect(performance.now() - disconnectedAt).toBeGreaterThanOrEqual(9900)
      expect(await row(play.id, profile)).toBeUndefined()
      for (const file of [shared, cache, download, halfway]) expect((await started(file)).exited).toBe(false)
      expect(spawned.encoders).toHaveLength(5)
    }, 22_000)

    it('shares the four-encode user cap with Subsonic live slots and leaves room for another user', async () => {
      setTranscodeSlotLimit(6)
      const release = tryAcquireSlot(userId, 3)!
      try {
        for (let index = 0; index < 2; index++) {
          const file = await addLong()
          connect(file)
          await started(file)
        }
        const background = await addLong()
        connect(background, 'next')
        const victim = await started(background)

        const foreground = await addLong()
        connect(foreground)
        await started(foreground)
        expect(victim.exited).toBe(true)

        const fifth = await addLong()
        const denied = await fetch(fifth.id, profile)
        expect(denied.statusCode).toBe(429)
        expect(denied.json().error.code).toBe('too_many_live_encodes')
        expect(() => tryAcquireSlot(userId, 3)).toThrow(expect.objectContaining({ status: 429, code: 'too_many_live_encodes' }))
        const other = await createUser({ username: 'second-listener' })
        connect(fifth, 'play', other.id)
        await started(fifth)
      } finally {
        release()
      }
    })
  })
})
