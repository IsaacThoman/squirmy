import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { and, eq, lt } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { transcodes } from '../../database/schema.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError } from '../../lib/errors.js'
import { audioInput } from '../../lib/ffmpeg.js'
import { newId } from '../../lib/ids.js'
import { libraryPath, serveFile, withLibraryFile, type StreamRequest, type StreamResponse } from './files.js'
import { outputSampleRate, profiles, type MediaFile, type TranscodeProfile } from './profiles.js'

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
  readonly done: Promise<void>
  private signal = deferred()

  constructor(readonly file: MediaFile, readonly profile: TranscodeProfile) {
    this.done = this.run()
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

  private async run() {
    let handle: FileHandle | undefined
    await acquireSlot()
    try {
      if (stopping) throw new Error('The server is stopping')
      const input = await libraryPath(this.file)
      const storagePath = storagePathFor(this.file, this.profile)
      const target = path.join(cacheRoot(), storagePath)
      await db.insert(transcodes).values({ id: newId(), fileId: this.file.id, profile: this.profile, storagePath, status: 'pending' })
        .onConflictDoUpdate({ target: [transcodes.fileId, transcodes.profile], set: { storagePath, status: 'pending', error: null, lastUsedAt: new Date() } })

      // A unique name, so a second process encoding the same profile cannot interleave writes.
      const temp = path.join(path.dirname(target), `.${this.profile}.${randomToken(6)}.part`)
      handle = await createIn(temp)
      this.tempPath = temp
      this.notify()

      const child = spawn(getConfig().FFMPEG_PATH, ffmpegArgs(input, this.file, this.profile), { stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code))
      })
      // Awaited below; this only keeps an early failure from being reported as unhandled.
      exited.catch(() => {})
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (text: string) => {
        stderr = (stderr + text).slice(-2000)
      })
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
          await handle.write(chunk)
          this.written += chunk.length
          this.notify()
        }
        const code = await exited
        if (code !== 0) throw new Error(`ffmpeg exited with ${code ?? 'a signal'}: ${stderr.trim()}`)
      } finally {
        // A failed write leaves ffmpeg running otherwise.
        if (child.exitCode === null) child.kill('SIGKILL')
        children.delete(child)
      }
      await handle.close()
      handle = undefined
      await rename(temp, target)
      // Readers that open after this point find the file under its final name.
      this.tempPath = target
      const { size } = await stat(target)
      await db.update(transcodes).set({ status: 'ready', bytes: size, error: null, lastUsedAt: new Date() })
        .where(and(eq(transcodes.fileId, this.file.id), eq(transcodes.profile, this.profile)))
    } catch (error) {
      this.error = error as Error
      await handle?.close().catch(() => {})
      if (this.tempPath) await unlink(this.tempPath).catch(() => {})
      await db.update(transcodes).set({ status: 'failed', error: this.error.message.slice(0, 2000) })
        .where(and(eq(transcodes.fileId, this.file.id), eq(transcodes.profile, this.profile), eq(transcodes.status, 'pending')))
        .catch(() => {})
    } finally {
      releaseSlot()
      active.delete(keyOf(this.file.id, this.profile))
      this.finished = true
      this.notify()
    }
  }
}

const keyOf = (fileId: string, profile: TranscodeProfile) => `${fileId}/${profile}`
const active = new Map<string, Transcode>()
const children = new Set<ChildProcess>()
let stopping = false

// ffmpeg is CPU bound; leave room for the API and the database on small machines.
const slotLimit = Math.max(2, Math.floor(availableParallelism() / 2))
let slotsInUse = 0
const slotQueue: (() => void)[] = []

async function acquireSlot() {
  if (slotsInUse < slotLimit) {
    slotsInUse++
    return
  }
  await new Promise<void>((resolve) => slotQueue.push(resolve))
}

function releaseSlot() {
  const next = slotQueue.shift()
  if (next) next()
  else slotsInUse--
}

/**
 * The ffmpeg command for one transcode: the first audio stream only (no pictures), a
 * whitelist of tags taken from the database rather than whatever the source carries,
 * written to stdout so every byte is final the moment it is produced.
 */
function ffmpegArgs(input: string, file: MediaFile, profile: TranscodeProfile): string[] {
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
  return [
    '-v', 'error', '-nostdin', ...audioInput(input),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    ...metadata.flatMap(([key, value]) => value === undefined || value === '' ? [] : ['-metadata', `${key}=${value}`]),
    ...(sampleRate ? ['-ar', String(sampleRate)] : []),
    ...profiles[profile].args,
    'pipe:1',
  ]
}

/**
 * A readable over a running transcode, from its first byte. It reads what the encoder has
 * written so far, then waits for more; it ends when the encoder does and errors if it fails.
 * Destroying it (a client that went away) closes the descriptor and leaves the encoder running.
 */
function follow(job: Transcode): Readable {
  let handle: FileHandle | undefined
  let position = 0
  return new Readable({
    async read(size) {
      try {
        for (;;) {
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

/** The running transcode for (file, profile), starting one when none is running in this process. */
function startTranscode(file: MediaFile, profile: TranscodeProfile): Transcode {
  const key = keyOf(file.id, profile)
  let job = active.get(key)
  if (!job) {
    job = new Transcode(file, profile)
    active.set(key, job)
  }
  return job
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

/**
 * Streams a transcode. A cached one is served with Range. Otherwise this joins (or starts)
 * the encoder and streams its output from the first byte as it is produced: 200, no
 * length, `Accept-Ranges: none`. HEAD reports those headers without starting anything.
 */
export async function openTranscode(file: MediaFile, profile: TranscodeProfile, request: StreamRequest, headers: Record<string, string> = {}): Promise<StreamResponse> {
  const cached = await serveCached(file, profile, request, headers)
  if (cached) return cached
  const source = await requireSource(file)
  const live = { 'content-type': profiles[profile].mime, 'accept-ranges': 'none', 'cache-control': 'private', ...headers }
  if (request.head) return { status: 200, headers: live, body: null }
  const job = startTranscode(source, profile)
  // Wait for the first bytes so an encoder that fails at once becomes an error response.
  while (job.written === 0 && !job.finished) await job.changed()
  if (job.error && job.written === 0) throw transcodeFailed(job.error)
  return { status: 200, headers: live, body: follow(job) }
}

const transcodeFailed = (error: Error) => error instanceof AppError ? error : new AppError(500, 'transcode_failed', 'The file could not be transcoded')

/** Builds (fileId, profile) into the cache unless it is already there. Resolves when it is ready. */
export async function prepareTranscode(file: MediaFile, profile: TranscodeProfile): Promise<void> {
  const row = await readyTranscode(file, profile)
  if (row && await stat(path.join(cacheRoot(), row.storagePath)).then(() => true, () => false)) {
    await touch(row)
    return
  }
  const job = startTranscode(await requireSource(file), profile)
  await job.done
  if (job.error) throw job.error
}

/** Kills every running encoder and waits for each to clean up. For shutdown. */
export async function stopTranscodes() {
  stopping = true
  for (const child of children) child.kill('SIGKILL')
  await Promise.all([...active.values()].map((job) => job.done))
  stopping = false
}
