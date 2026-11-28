/**
 * Share previews: the first 30 seconds of a song, cut by ffmpeg into an MP3 of its own.
 *
 * Cutting the audio, rather than limiting the bytes a client may read, is what makes the limit
 * hold: a byte offset says nothing about time in a variable-bitrate or lossless file, and a
 * listener can always ask for another range. The preview file holds nothing past 30 seconds.
 * MP3 because every browser plays it, with a Xing header (the file is written whole, then
 * renamed into place) so its duration is known and seeking works.
 *
 * Previews live in `<data>/previews/<fileId>/<size>-<mtime>.mp3`, apart from the transcode cache,
 * whose sweep deletes files it has no row for. A replaced or retagged file gets a new name;
 * the `share.sweep` job deletes previews nobody played for a week.
 */
import { mkdir, readdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { SHARE_PREVIEW_MS } from '@squirmy/contracts'
import { getConfig } from '../../config.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError } from '../../lib/errors.js'
import { audioInput, runFfmpeg } from '../../lib/ffmpeg.js'
import { serveFile, withLibraryFile, type MediaFile, type StreamRequest, type StreamResponse } from '../streaming/index.js'

export const PREVIEW_MIME = 'audio/mpeg'

/** Previews not played for this long are deleted by the sweep. */
export const PREVIEW_KEPT_MS = 7 * 24 * 60 * 60_000
/** A served preview's mtime is refreshed at most this often, which is what the sweep reads. */
const TOUCH_MS = 60 * 60_000
/** A preview takes well under a second to cut; a few at once is plenty, and leaves the CPU to playback. */
const ENCODERS = 2
/** Requests past this many waiting for an encoder are told to try again. */
const QUEUE_LIMIT = 32
/** Seconds of fade at the end, so a preview stops rather than cuts off. */
const FADE_SEC = 2

export const previewRoot = () => path.join(getConfig().SQUIRMY_DATA_DIR, 'previews')

/** Where a file's preview is kept. The name changes when the file does. */
export function previewPath(file: Pick<MediaFile, 'id' | 'size' | 'mtime'>): string {
  return path.join(previewRoot(), file.id, `${file.size}-${Math.floor(file.mtime.getTime())}.mp3`)
}

const encoding = new Map<string, Promise<void>>()
let running = 0
const waiting: (() => void)[] = []

async function withEncoder<T>(work: () => Promise<T>): Promise<T> {
  if (running >= ENCODERS) {
    if (waiting.length >= QUEUE_LIMIT) throw new AppError(503, 'transcoder_busy', 'Too many previews are being made; try again shortly')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    running += 1
  }
  try {
    return await work()
  } finally {
    // The slot passes to the next waiter as it is, or is freed.
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
}

const seconds = SHARE_PREVIEW_MS / 1000

/** ffmpeg arguments that write the first `SHARE_PREVIEW_MS` of `input` to `output` as MP3. */
export function previewArgs(input: string, output: string): string[] {
  return [
    ...audioInput(input),
    '-map', '0:a:0', '-vn', '-map_metadata', '-1',
    '-t', String(seconds),
    '-af', `afade=t=out:st=${seconds - FADE_SEC}:d=${FADE_SEC}`,
    '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', '160k', '-f', 'mp3', '-y', output,
  ]
}

async function encode(file: MediaFile, target: string) {
  await mkdir(path.dirname(target), { recursive: true })
  await withLibraryFile(file, async (input) => {
    if (!await stat(input).then((info) => info.isFile(), () => false)) return null
    const partial = `${target}.${randomToken(6)}.part`
    try {
      await runFfmpeg(previewArgs(input, partial), { timeoutMs: 60_000 })
      await rename(partial, target)
    } catch (error) {
      await unlink(partial).catch(() => {})
      throw error
    }
    return true
  })
}

/** Makes the preview unless it exists; one encode per preview however many ask at once. */
async function ensurePreview(file: MediaFile, target: string) {
  let job = encoding.get(target)
  if (!job) {
    job = withEncoder(() => encode(file, target)).finally(() => encoding.delete(target))
    encoding.set(target, job)
  }
  await job
}

/** Serves a file's preview, cutting it first when there is none, with Range and HEAD. */
export async function servePreview(file: MediaFile, request: StreamRequest): Promise<StreamResponse> {
  const target = previewPath(file)
  const info = await stat(target).catch(() => null)
  if (!info) await ensurePreview(file, target)
  else if (Date.now() - info.mtimeMs > TOUCH_MS) {
    const now = new Date()
    await utimes(target, now, now).catch(() => {})
  }
  const response = await serveFile(target, PREVIEW_MIME, request)
  if (!response) throw new AppError(503, 'preview_unavailable', 'The preview is not ready; try again')
  return response
}

/** Deletes previews not played for `PREVIEW_KEPT_MS`, leftovers of failed encodes, and empty folders. */
export async function sweepPreviews(now = Date.now()) {
  const root = previewRoot()
  for (const folder of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory()) continue
    const directory = path.join(root, folder.name)
    for (const name of await readdir(directory).catch(() => [])) {
      const file = path.join(directory, name)
      const info = await stat(file).catch(() => null)
      if (info && now - info.mtimeMs > (name.endsWith('.part') ? 60 * 60_000 : PREVIEW_KEPT_MS)) await unlink(file).catch(() => {})
    }
    // Fails while the folder still holds something, which is what we want.
    await rmdir(directory).catch(() => {})
  }
}
