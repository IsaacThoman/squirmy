import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { addAbortSignal, Readable } from 'node:stream'
import { StreamIntent } from '@squirmy/contracts'
import { and, eq, lt } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { transcodes } from '../../database/schema.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { audioInput } from '../../lib/ffmpeg.js'
import { newId } from '../../lib/ids.js'
import { libraryPath, serveFile, withLibraryFile, type StreamRequest, type StreamResponse } from './files.js'
import { rewritePacketDurations } from './mp4.js'
import { codecFamily, fragmentedEncoder, isFragmented, mp4Options, outputBitDepth, outputSampleRate, profiles, sourceSampleRate, type MediaFile, type TranscodeProfile } from './profiles.js'

type TranscodeRow = typeof transcodes.$inferSelect

/** `<data>/transcodes`, the root of the transcode cache. */
export const cacheRoot = () => path.join(getConfig().SQUIRMY_DATA_DIR, 'transcodes')

/**
 * Where a finished transcode lives, relative to the cache root (the `storage_path` column).
 * The name carries the source's size and mtime as the scanner last saw them, so a file
 * replaced or retagged in place no longer matches its old transcode and is encoded again;
 * eviction deletes the old one.
 */
export function storagePathFor(file: Pick<MediaFile, 'id' | 'size' | 'mtime'>, profile: TranscodeProfile): string {
  const source = `${file.size.toString(36)}-${file.mtime.getTime().toString(36)}`
  return `${file.id}/${profile}.${source}.${profiles[profile].extension}`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Seek = { seconds: number; frame: number; trimFrames?: number }

/**
 * One running ffmpeg. Its output is appended to `tempPath`; readers follow the file up to
 * `written` bytes and wait on `changed()` for more, so no client holds the encoder back and
 * nothing is buffered in memory.
 */
class Transcode {
  tempPath: string | null = null
  written = 0
  finished = false
  error: Error | null = null
  startFrame: number | undefined
  readonly started = deferred()
  readonly ready = deferred()
  readonly done: Promise<void>
  private signal = deferred()
  private readonly controller = new AbortController()
  private readonly readers = new Set<{ intent: StreamIntent }>()
  private idleTimer: NodeJS.Timeout | undefined
  private lastIntent: StreamIntent
  private cacheIntent: StreamIntent | undefined
  private encodedMs = 0
  private child: ChildProcess | undefined
  private publishing = false

  constructor(
    readonly file: MediaFile, readonly profile: TranscodeProfile, readonly userId: string | undefined,
    intent: StreamIntent, private readonly seek?: Seek,
  ) {
    this.lastIntent = intent
    this.startFrame = seek?.frame
    this.done = this.run()
  }

  get intent(): StreamIntent {
    let intent = this.cacheIntent
    for (const reader of this.readers) {
      if (!intent || priority(reader.intent) < priority(intent)) intent = reader.intent
    }
    return intent ?? this.lastIntent
  }

  get cancelled() {
    return this.controller.signal.aborted
  }

  get interruptible() {
    return !this.cancelled && !this.publishing
  }

  get abandoned() {
    if (this.seek) return this.readers.size === 0
    const halfway = this.file.durationMs > 0 && this.encodedMs * 2 >= this.file.durationMs
    return this.readers.size === 0 && !this.cacheIntent && !halfway
  }

  attach(intent: StreamIntent) {
    const reader = { intent }
    this.readers.add(reader)
    clearTimeout(this.idleTimer)
    if (intent === 'cache' || (intent === 'download' && !this.cacheIntent)) this.cacheIntent = intent
    return () => {
      this.lastIntent = this.intent
      if (!this.readers.delete(reader)) return
      if (this.seek && this.abandoned) {
        if (this.finished) void this.removeTemporaryFile()
        else this.cancel()
      }
      if (this.interruptible && this.abandoned) {
        if (slotQueue.has(this)) this.cancel()
        else {
          this.idleTimer = setTimeout(() => {
            if (this.abandoned) this.cancel()
          }, 10_000).unref()
        }
      }
      scheduleEncoders()
    }
  }

  cancel(error = transcoderBusy()) {
    if (!this.interruptible) return
    this.controller.abort(error)
    this.started.resolve()
    this.child?.kill('SIGKILL')
  }

  /** Resolves on the next write, failure or completion. */
  changed(): Promise<void> {
    return this.signal.promise
  }

  private notify() {
    const { resolve } = this.signal
    this.signal = deferred()
    resolve()
  }

  private async removeTemporaryFile() {
    if (this.tempPath) await unlink(this.tempPath).catch(() => {})
  }

  private async run() {
    let handle: FileHandle | undefined
    let pending = false
    const signal = this.controller.signal
    const storagePath = storagePathFor(this.file, this.profile)
    const rowKey = and(eq(transcodes.fileId, this.file.id), eq(transcodes.profile, this.profile), eq(transcodes.storagePath, storagePath))
    await this.started.promise
    try {
      signal.throwIfAborted()
      const input = await libraryPath(this.file)
      signal.throwIfAborted()
      const target = path.join(cacheRoot(), storagePath)
      if (!this.seek) {
        await db.insert(transcodes).values({ id: newId(), fileId: this.file.id, profile: this.profile, storagePath, status: 'pending' })
          .onConflictDoUpdate({ target: [transcodes.fileId, transcodes.profile], set: { storagePath, status: 'pending', error: null, lastUsedAt: new Date() } })
        pending = true
      }
      signal.throwIfAborted()

      // A unique name, so a second process encoding the same profile cannot interleave writes.
      const temp = path.join(path.dirname(target), `.${this.profile}.${randomToken(6)}.part`)
      handle = await createIn(temp)
      this.tempPath = temp
      signal.throwIfAborted()

      const remuxSeek = this.profile === 'copy_mp4' && this.seek
      const child = spawn(getConfig().FFMPEG_PATH, ffmpegArgs(input, this.file, this.profile, this.seek), {
        stdio: remuxSeek ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      let processError: Error | undefined
      child.once('error', (error) => { processError = error })
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve))
      let stderr = ''
      createInterface({ input: child.stderr! }).on('line', (line) => {
        if (line.startsWith('out_time_us=')) {
          const microseconds = Number(line.slice('out_time_us='.length))
          if (Number.isFinite(microseconds)) this.encodedMs = Math.max(this.encodedMs, microseconds / 1000)
        } else if (!/^\w+=/.test(line)) {
          stderr = `${stderr}
${line}`.slice(-2000)
        }
      })
      try {
        const packetFrames = fragmentedEncoder(this.profile)?.packetFrames
          ?? (this.profile === 'copy_mp4' && codecFamily(this.file) === 'aac' ? 'source' : undefined)
        const pipe = child.stdout as AsyncIterable<Buffer>
        const output = packetFrames ? rewritePacketDurations(pipe, packetFrames) : pipe
        const packetStart = remuxSeek ? firstPacketFrame(child.stdio[3] as Readable, exited) : undefined
        for await (const chunk of output) {
          signal.throwIfAborted()
          if (packetStart && this.written === 0) {
            this.startFrame = await packetStart
            if (this.startFrame === undefined) throw new Error('FFmpeg did not report a remux start frame')
          }
          await handle.write(chunk)
          this.written += chunk.length
          this.ready.resolve()
          this.notify()
        }
        const code = await exited
        signal.throwIfAborted()
        if (processError) throw processError
        if (code !== 0) throw new Error(`ffmpeg exited with ${code ?? 'a signal'}: ${stderr.trim()}`)
      } finally {
        // Wait for process exit before handing the slot to another encoder.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
        this.child = undefined
      }
      signal.throwIfAborted()
      this.publishing = true
      await handle.close()
      handle = undefined
      if (this.seek) return
      await rename(temp, target)
      // Readers that open after this point find the file under its final name.
      this.tempPath = target
      const { size } = await stat(target)
      await db.update(transcodes).set({ status: 'ready', bytes: size, error: null, lastUsedAt: new Date() }).where(rowKey)
    } catch (error) {
      this.error = signal.aborted ? signal.reason as Error : error as Error
      await handle?.close().catch(() => {})
      await this.removeTemporaryFile()
      if (pending) {
        const where = and(rowKey, eq(transcodes.status, 'pending'))
        if (this.cancelled) await db.delete(transcodes).where(where).catch(() => {})
        else await db.update(transcodes).set({ status: 'failed', error: this.error.message.slice(0, 2000) }).where(where).catch(() => {})
      }
    } finally {
      clearTimeout(this.idleTimer)
      if (this.seek && this.abandoned) await this.removeTemporaryFile()
      active.delete(keyOf(this.file.id, this.profile, this.seek))
      slotQueue.delete(this)
      running.delete(this)
      this.finished = true
      this.ready.resolve()
      this.notify()
      scheduleEncoders()
    }
  }
}

const priority = (intent: StreamIntent) => StreamIntent.options.indexOf(intent)
const keyOf = (fileId: string, profile: TranscodeProfile, seek?: Seek) => `${fileId}/${profile}${seek ? `/${seek.seconds}/${seek.frame}` : ''}`
const active = new Map<string, Transcode>()
const slotQueue = new Set<Transcode>()
const running = new Set<Transcode>()
const liveByUser = new Map<string, number>()
let liveSlots = 0
let stopping = false

// ffmpeg is CPU bound; leave room for the API and the database on small machines.
const defaultSlotLimit = Math.max(2, Math.floor(availableParallelism() / 2))
const encodesPerUser = 4
let slotLimit = defaultSlotLimit
const hasFreeSlot = () => running.size + liveSlots < slotLimit

/** Changes how many encoders may run at once; null restores the default. For tests. */
export function setTranscodeSlotLimit(limit: number | null) {
  slotLimit = limit ?? defaultSlotLimit
  scheduleEncoders()
}

function lowestPriority(jobs: Iterable<Transcode>, eligible: (job: Transcode) => boolean) {
  let lowest: Transcode | undefined
  for (const job of jobs) {
    if (job.interruptible && eligible(job) && (!lowest || priority(job.intent) > priority(lowest.intent))) lowest = job
  }
  return lowest
}

function scheduleEncoders() {
  if (stopping) return
  let waitingPlay = false
  // Stable sort keeps arrivals in order within a priority.
  for (const job of [...slotQueue].sort((a, b) => priority(a.intent) - priority(b.intent))) {
    if (job.cancelled) continue
    const own = job.userId ? [...running].filter((encode) => encode.userId === job.userId) : []
    if (job.userId && own.length + (liveByUser.get(job.userId) ?? 0) >= encodesPerUser) {
      if (own.some((encode) => encode.cancelled)) continue
      const victim = lowestPriority(own, (encode) => encode.intent !== 'play' || (job.intent === 'play' && encode.abandoned))
      if (victim) victim.cancel()
      else if (own.every((encode) => encode.interruptible)) job.cancel(tooManyEncodes())
      continue
    }
    if (!hasFreeSlot()) {
      waitingPlay ||= job.intent === 'play'
      continue
    }
    slotQueue.delete(job)
    running.add(job)
    job.started.resolve()
  }

  if (!waitingPlay || [...running].some((job) => !job.interruptible)) return
  const victim = lowestPriority(running, (job) => priority(job.intent) > priority('next'))
    // A skip can fill every slot with abandoned plays before the reconnect grace expires.
    ?? lowestPriority(running, (job) => job.abandoned)
  victim?.cancel()
}

/**
 * Takes a slot without waiting for a Subsonic live encode. These requests retain their own
 * limit inside the combined per-user cap and let queued streams take freed slots first.
 */
export function tryAcquireSlot(userId: string, liveLimit: number): (() => void) | null {
  const live = liveByUser.get(userId) ?? 0
  if (live >= liveLimit || live + [...running].filter((job) => job.userId === userId).length >= encodesPerUser) {
    throw tooManyEncodes()
  }
  if (stopping || !hasFreeSlot()) return null
  liveByUser.set(userId, live + 1)
  liveSlots++
  let released = false
  return () => {
    if (released) return
    released = true
    const count = liveByUser.get(userId)!
    if (count === 1) liveByUser.delete(userId)
    else liveByUser.set(userId, count - 1)
    liveSlots--
    scheduleEncoders()
  }
}

const tooManyEncodes = () => new AppError(429, 'too_many_live_encodes', 'Too many streams are being converted for this user; try again shortly')

/** Every encoder slot is taken: 503 `transcoder_busy`. */
export const transcoderBusy = () => new AppError(503, 'transcoder_busy', 'Too many transcodes are running; try again shortly')

/**
 * The ffmpeg command for one transcode: the first audio stream only (no pictures), a
 * whitelist of tags taken from the database rather than whatever the source carries,
 * written to stdout so every byte is final the moment it is produced.
 */
function ffmpegArgs(input: string, file: MediaFile, profile: TranscodeProfile, seek?: Seek): string[] {
  const tags = file.tags
  const metadata: [string, string | number | undefined][] = [
    ['title', tags.title],
    ['artist', tags.artist],
    ['album', tags.album],
    ['album_artist', tags.albumArtist],
    ['track', tags.track],
    ['disc', tags.disc],
    ['date', tags.date ?? tags.year],
    ['genre', tags.genres?.join('; ')],
  ]
  const sampleRate = outputSampleRate(file, profile)
  const copy = profile === 'copy_mp4'
  const remuxSeek = copy && seek
  // With copyts, the side muxer reports where the first packet sits on the source
  // timeline even though the MP4 muxer rebases the fragment timestamps to zero.
  const muxer = remuxSeek ? [
    '-c:a', 'copy', '-f', 'tee',
    `[f=mp4:strict=-2:${Object.entries(mp4Options).map(([key, value]) => `${key}=${value}`).join(':')}]pipe:1|[f=framecrc:flush_packets=1]pipe:3`,
  ] : [...profiles[profile].args, 'pipe:1']
  return [
    '-v', 'error', '-nostdin', '-progress', 'pipe:2',
    ...(remuxSeek ? ['-copyts', '-start_at_zero'] : []),
    ...(seek ? ['-ss', seek.seconds.toFixed(6)] : []), ...audioInput(input),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    ...metadata.flatMap(([key, value]) => value === undefined || value === '' ? [] : ['-metadata', `${key}=${value}`]),
    ...(sampleRate && !copy ? ['-ar', String(sampleRate)] : []),
    ...(seek?.trimFrames ? ['-af', `aresample=${sampleRate},atrim=start_sample=${seek.trimFrames},asetpts=PTS-STARTPTS`] : []),
    ...(profile === 'flac_mp4' ? ['-sample_fmt', outputBitDepth(file, profile) === 16 ? 's16' : 's32'] : []),
    ...(copy && codecFamily(file) === 'aac' ? ['-bsf:a', 'aac_adtstoasc'] : []),
    ...muxer,
  ]
}

/** Observes the first copied packet in the framecrc side output, then drains that pipe. */
function firstPacketFrame(pipe: Readable, exited: Promise<number | null>): Promise<number | undefined> {
  return new Promise((resolve) => {
    let timeBase: number | undefined
    let rate: number | undefined
    const lines = createInterface({ input: pipe })
    lines.on('line', (line) => {
      const tb = /^#tb 0: (\d+)\/(\d+)$/.exec(line)
      if (tb) timeBase = Number(tb[1]) / Number(tb[2])
      const sampleRate = /^#sample_rate 0: (\d+)$/.exec(line)
      if (sampleRate) rate = Number(sampleRate[1])
      const pts = /^0,\s*-?\d+,\s*(-?\d+),/.exec(line)
      if (!pts || !timeBase || !rate) return
      resolve(Math.max(0, Math.round(Number(pts[1]) * timeBase * rate)))
      lines.close()
      pipe.resume()
    })
    void exited.then(() => resolve(undefined))
  })
}

/**
 * A readable over a running transcode, from its first byte. It reads what the encoder has
 * written so far, then waits for more; it ends when the encoder does and errors if it fails.
 * Destroying it closes the descriptor and releases this reader's interest in the encoder.
 */
function follow(job: Transcode, detach: () => void): Readable {
  let handle: FileHandle | undefined
  let position = 0
  return new Readable({
    async read(size) {
      try {
        for (;;) {
          if (job.cancelled && job.error) throw job.error
          if (!handle && job.tempPath) {
            const opened = await openEither(job)
            if (this.destroyed) {
              await opened.close()
              return
            }
            handle = opened
          }
          if (handle && position < job.written) {
            const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 64 * 1024), job.written - position))
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
            position += bytesRead
            this.push(buffer.subarray(0, bytesRead))
            return
          }
          if (job.error) throw job.error
          if (job.finished) {
            this.push(null)
            return
          }
          await job.changed()
          if (this.destroyed) return
        }
      } catch (error) {
        this.destroy(error as Error)
      }
    },
    destroy(error, callback) {
      detach()
      const current = handle
      handle = undefined
      if (!current) return callback(error)
      current.close().then(() => callback(error), () => callback(error))
    },
  })
}

/** Opens the job's output, which may be renamed from its temporary name at any moment. */
async function openEither(job: Transcode): Promise<FileHandle> {
  for (;;) {
    const file = job.tempPath!
    try {
      return await open(file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || job.tempPath === file) throw error
    }
  }
}

/**
 * Creates a file and its folder. Eviction removes empty folders, possibly between the two
 * steps, so a vanished folder is made once more.
 */
async function createIn(file: string): Promise<FileHandle> {
  for (let attempt = 0; ; attempt++) {
    await mkdir(path.dirname(file), { recursive: true })
    try {
      return await open(file, 'w')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt > 0) throw error
    }
  }
}

/** Wait without keeping a closed request attached to the work. */
async function waitForEncode(promise: Promise<void>, signal?: AbortSignal) {
  if (!signal) return promise
  signal.throwIfAborted()
  const aborted = deferred()
  signal.addEventListener('abort', aborted.resolve, { once: true })
  try {
    await Promise.race([promise, aborted.promise])
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', aborted.resolve)
  }
}

/** True while this process is encoding (fileId, profile). */
export const isTranscoding = (fileId: string, profile: string) => active.has(`${fileId}/${profile}`)

const touched = new Map<string, number>()

/** Bumps `last_used_at`, at most once a minute per row. */
async function touch(row: TranscodeRow) {
  const now = Date.now()
  if ((touched.get(row.id) ?? 0) > now - 60_000) return
  if (touched.size > 10_000) touched.clear()
  touched.set(row.id, now)
  await db.update(transcodes).set({ lastUsedAt: new Date(now) })
    .where(and(eq(transcodes.id, row.id), lt(transcodes.lastUsedAt, new Date(now - 60_000))))
}

/** The ready transcode of the file as it is now, if there is one. */
export async function readyTranscode(file: MediaFile, profile: TranscodeProfile): Promise<TranscodeRow | undefined> {
  const [row] = await db.select().from(transcodes).where(and(
    eq(transcodes.fileId, file.id), eq(transcodes.profile, profile), eq(transcodes.status, 'ready'),
    eq(transcodes.storagePath, storagePathFor(file, profile)),
  ))
  return row
}

/**
 * Serves the cached transcode when it is ready on disk (with Range, like an original).
 * Returns null and forgets the row when its file has gone.
 */
async function serveCached(file: MediaFile, profile: TranscodeProfile, request: StreamRequest, headers: Record<string, string>): Promise<StreamResponse | null> {
  const row = await readyTranscode(file, profile)
  if (!row) return null
  const response = await serveFile(path.join(cacheRoot(), row.storagePath), profiles[profile].mime, request, headers)
  if (!response) {
    await db.delete(transcodes).where(and(eq(transcodes.id, row.id), eq(transcodes.status, 'ready')))
    return null
  }
  await touch(row)
  return response
}

/**
 * The file with the path its source is at now (it may be in the middle of a move). Fails
 * with 404, and marks the file missing, when the source is gone from disk.
 */
function requireSource(file: MediaFile): Promise<MediaFile> {
  return withLibraryFile(file, async (absolutePath, at) => (await stat(absolutePath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return false
  })) ? at : null)
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function planSeek(file: MediaFile, profile: TranscodeProfile, startMs: number): Seek | undefined {
  const sourceRate = sourceSampleRate(file)
  const outputRate = outputSampleRate(file, profile)
  if (!sourceRate || !outputRate) throw badRequest('The audio sample rate is unknown', 'seek_unavailable')
  const frame = Math.round(startMs * outputRate / 1000)
  if (!Number.isSafeInteger(frame)) throw badRequest('The seek position is too large', 'invalid_start')
  const frames = file.decodedFrames ?? (file.durationMs > 0 ? Math.round(file.durationMs * sourceRate / 1000) : null)
  if (frames !== null && frame >= Math.ceil(frames * outputRate / sourceRate)) {
    throw badRequest('The seek starts beyond the end of the track', 'invalid_start')
  }
  if (profile === 'copy_mp4') {
    // Leave time for overlap and the MP3 bit reservoir, plus a packet's rounding.
    const seconds = Math.max(0, (startMs - 150) / 1000)
    return seconds > 0 ? { seconds, frame: 0 } : undefined
  }
  if (frame === 0) return undefined
  if (sourceRate === outputRate) return { seconds: frame / sourceRate, frame }
  // Start on a frame shared by both sample clocks, so resampling uses the same
  // phase as the full encode. Trim in the output clock after resampler preroll.
  const phase = outputRate / gcd(sourceRate, outputRate)
  const preroll = Math.ceil(64 * outputRate / sourceRate)
  const start = Math.max(0, Math.floor((frame - preroll) / phase) * phase)
  return { seconds: start / outputRate, frame, trimFrames: frame - start }
}

/**
 * Streams a transcode. A cached one is served with Range. Otherwise this joins (or starts)
 * the encoder and streams its output from the first byte as it is produced: 200, no
 * length, `Accept-Ranges: none`. HEAD reports those headers without starting anything.
 */
export async function openTranscode(file: MediaFile, profile: TranscodeProfile, request: StreamRequest, headers: Record<string, string> = {}): Promise<StreamResponse> {
  if (profile === 'copy_mp4' && !['aac', 'flac', 'mp3'].includes(codecFamily(file))) {
    throw badRequest('This codec cannot be remuxed for playback', 'unsupported_remux')
  }
  const startMs = isFragmented(profile) ? request.startMs : undefined
  const seek = startMs && !request.range ? planSeek(file, profile, startMs) : undefined
  const responseHeaders = startMs !== undefined && !request.range
    ? { ...headers, 'x-squirmy-start-frame': String(seek?.frame ?? 0), 'access-control-expose-headers': 'X-Squirmy-Start-Frame' }
    : headers
  if (!seek) {
    const cached = await serveCached(file, profile, request, responseHeaders)
    if (cached) return cached
  }
  const source = await requireSource(file)
  const live: Record<string, string> = { 'content-type': profiles[profile].mime, 'accept-ranges': 'none', 'cache-control': seek ? 'no-store' : 'private', ...responseHeaders }
  // A remux seek's start frame is only known once the first packet has been copied.
  if (seek && profile === 'copy_mp4') delete live['x-squirmy-start-frame']
  if (request.head) return { status: 200, headers: live, body: null }
  const { signal, intent = 'play', userId } = request
  const key = keyOf(source.id, profile, seek)
  signal?.throwIfAborted()
  let job = active.get(key)
  while (job?.cancelled) {
    await waitForEncode(job.done, signal)
    job = active.get(key)
  }
  if (stopping) throw transcoderBusy()
  if (!job) {
    job = new Transcode(source, profile, userId, intent, seek)
    active.set(key, job)
    slotQueue.add(job)
  }
  const detach = job.attach(intent)
  scheduleEncoders()
  try {
    // Wait for the first bytes so an encoder that fails at once becomes an error response.
    await waitForEncode(job.ready.promise, signal)
    if (job.error && job.written === 0) throw transcodeFailed(job.error)
    if (job.startFrame !== undefined) live['x-squirmy-start-frame'] = String(job.startFrame)
    const body = follow(job, detach)
    return { status: 200, headers: live, body: signal ? addAbortSignal(signal, body) : body }
  } catch (error) {
    detach()
    throw error
  }
}

const transcodeFailed = (error: Error) => error instanceof AppError ? error : new AppError(500, 'transcode_failed', 'The file could not be transcoded')

/** Kills every running encoder and waits for each to clean up. For shutdown. */
export async function stopTranscodes() {
  stopping = true
  for (const job of active.values()) job.cancel()
  await Promise.all([...active.values()].map((job) => job.done))
  stopping = false
}
