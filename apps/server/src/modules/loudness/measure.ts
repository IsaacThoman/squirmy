import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { audioInput } from '../../lib/ffmpeg.js'
import { db } from '../../database/client.js'
import { mediaFiles, releaseLoudness, releaseTracks } from '../../database/schema.js'
import { libraryPath } from '../streaming/files.js'
import { SILENT_LUFS } from './normalization.js'

const exec = promisify(execFile)

export type Loudness = { lufs: number; truePeakDb: number }
type TrackMeasurement = Loudness & {
  decodedFrames: number
  decodedRate: number
  primingFrames: number
  paddingFrames: number
}

/** Stored as the true peak of digital silence, which ebur128 reports as -inf. */
const SILENT_PEAK_DB = -144

const number = String.raw`(-?inf|nan|-?\d+(?:\.\d+)?)`

function parseLevel(text: string): number {
  const lower = text.toLowerCase()
  if (lower === 'nan') return Number.NaN
  if (lower.endsWith('inf')) return lower.startsWith('-') ? -Infinity : Infinity
  return Number(text)
}

function integratedLoudness(summary: string): number | null {
  const integrated = new RegExp(String.raw`\bI:\s+${number}\s+LUFS`, 'i').exec(summary)
  if (!integrated?.[1]) return null
  const lufs = parseLevel(integrated[1])
  return Number.isFinite(lufs) && lufs > SILENT_LUFS ? lufs : SILENT_LUFS
}

/**
 * Reads integrated loudness and true peak from the summary ebur128 logs when its input
 * ends. Only the last summary counts. Unmeasurable values (silence, input shorter than a
 * gating block) become the silence sentinels. Null when there is no summary at all.
 */
export function parseEbur128(log: string): Loudness | null {
  const start = log.lastIndexOf('Summary:')
  if (start < 0) return null
  const summary = log.slice(start)
  const lufs = integratedLoudness(summary)
  const peak = new RegExp(String.raw`\bPeak:\s+${number}\s+dB(?:FS|TP)`, 'i').exec(summary)
  if (lufs === null || !peak?.[1]) return null
  const truePeakDb = parseLevel(peak[1])
  return {
    lufs,
    truePeakDb: Number.isFinite(truePeakDb) ? truePeakDb : SILENT_PEAK_DB,
  }
}

const ffmpegOptions = ['-hide_banner', '-nostdin', '-nostats', '-abort_on', 'empty_output']
const meterOptions = { timeout: 60 * 60_000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' } as const
const meterLog = ['-v', 'level+info']
const audioStream = ['-map', '0:a:0']
// Decoding stays lenient, as playback is: a damaged frame or a short tail still plays, so
// it is measured. Only a file ffmpeg cannot decode at all is a failure.
const decodeInput = audioInput

/** EBU R128 and sample counts from the same decode of the first audio stream. */
export async function measureLoudness(file: string): Promise<TrackMeasurement> {
  const { stderr } = await exec(getConfig().FFMPEG_PATH, [
    ...ffmpegOptions, '-v', 'level+debug', ...decodeInput(file), ...audioStream,
    // Log the meter's ticks at trace level so the decoder's debug log stays small.
    '-af', 'ebur128=peak=true:framelog=56', '-f', 'null', '-',
  ], meterOptions)
  const result = parseEbur128(stderr)
  if (!result) throw new Error('ffmpeg printed no loudness summary')

  // The null output keeps the source rate. Its final sample count includes only the
  // PCM ffmpeg actually decoded, after any skip/discard side data has been applied.
  const decodeLog = stderr.slice(stderr.indexOf('[info] Stream mapping:'))
  const decodedRate = Number(/\[info\]\s+Stream #0:0[^\n]*: Audio: pcm_s16le, (\d+) Hz/.exec(decodeLog)?.[1])
  const decodedFrames = Number(/Output stream #0:0 \(audio\): \d+ frames encoded \((\d+) samples\)/.exec(decodeLog)?.[1])
  if (!Number.isSafeInteger(decodedFrames) || decodedFrames <= 0 || !Number.isInteger(decodedRate) || decodedRate <= 0) {
    throw new Error('ffmpeg printed no decoded audio length')
  }

  // Ignore the probe's copy of these messages before "Stream mapping". MP3's gapless
  // metadata includes decoder delay, so use the number ffmpeg actually trims.
  let primingFrames = 0
  let paddingFrames = 0
  for (const [, skip, discard] of decodeLog.matchAll(/\[debug\] skip (\d+) \/ discard (\d+) samples due to side data/g)) {
    primingFrames ||= Number(skip)
    paddingFrames += Number(discard)
  }
  return { ...result, decodedFrames, decodedRate, primingFrames, paddingFrames }
}

async function* albumPcm(files: string[], channels: string[], signal: AbortSignal) {
  for (const file of files) {
    signal.throwIfAborted()
    const decoder = spawn(getConfig().FFMPEG_PATH, [
      ...ffmpegOptions, '-v', 'error', ...decodeInput(file), ...audioStream,
      ...channels, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' })
    let detail = ''
    decoder.stderr.setEncoding('utf8').on('data', (chunk: string) => { detail = (detail + chunk).slice(-4096) })
    const closed = new Promise<Error | null>((resolve) => {
      let spawnError: Error | undefined
      decoder.on('error', (error) => { spawnError = error })
      decoder.once('close', (code, killedBy) => {
        resolve(spawnError ?? (code === 0 ? null : new Error(`ffmpeg decoding ${file} exited with ${killedBy ?? code}: ${detail.trim()}`)))
      })
    })
    try {
      yield* decoder.stdout
      const error = await closed
      if (error) throw error
    } finally {
      // A failed meter can stop consuming PCM while the current decoder is still writing.
      if (decoder.exitCode === null && decoder.signalCode === null) decoder.kill('SIGKILL')
      await closed
    }
  }
}

/**
 * One continuous EBU R128 programme, so gating includes blocks that cross track boundaries.
 * Decode one track at a time into the same 48 kHz layout, with pipe backpressure bounding
 * memory even when a track is long. The release uses the maximum measured track true peak.
 */
export async function measureAlbumLoudness(files: string[], allMono: boolean): Promise<number> {
  const channels = ['-ar', '48000', '-ac', allMono ? '1' : '2']
  const controller = new AbortController()
  const meter = exec(getConfig().FFMPEG_PATH, [
    ...ffmpegOptions, ...meterLog, '-f', 'f32le', ...channels, '-i', 'pipe:0',
    '-af', 'ebur128=framelog=verbose', '-f', 'null', '-',
  ], { ...meterOptions, signal: controller.signal })
  const feed = pipeline(albumPcm(files, channels, controller.signal), meter.child.stdin!)
  try {
    const [{ stderr }] = await Promise.all([meter, feed])
    const start = stderr.lastIndexOf('Summary:')
    const lufs = start < 0 ? null : integratedLoudness(stderr.slice(start))
    if (lufs === null) throw new Error('ffmpeg printed no album loudness summary')
    return lufs
  } finally {
    controller.abort()
    await Promise.allSettled([meter, feed])
  }
}

const isMissing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
export const LOUDNESS_ERROR_PREFIX = 'Loudness measurement failed: '
const isLoudnessError = (error: string | null) => error?.startsWith(LOUDNESS_ERROR_PREFIX) ?? false

async function inputExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Keep decode failures out of the sweep after retries. As with probe failures, a scan
 * clears the error when the file changes. A missing file is left for the scanner.
 */
export async function measureFile(fileId: string, lastAttempt: boolean): Promise<string | null> {
  const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.id, fileId), isNull(mediaFiles.missingSince)))
  if (!file || file.probeStage < 1 || (file.probeError && !isLoudnessError(file.probeError))) return null
  const input = await libraryPath(file)
  if (!await inputExists(input)) return null

  // A scan or move can replace the input while ffmpeg is reading it.
  const sameFile = and(eq(mediaFiles.id, fileId), isNull(mediaFiles.missingSince),
    eq(mediaFiles.rootId, file.rootId), eq(mediaFiles.relPath, file.relPath),
    eq(mediaFiles.size, file.size), eq(mediaFiles.mtime, file.mtime),
    sql`${mediaFiles.probeError} is not distinct from ${file.probeError}`)
  let result: TrackMeasurement
  try {
    result = await measureLoudness(input)
  } catch (error) {
    if (!await inputExists(input)) return null
    const failure = error as Error & { code?: number; stderr?: string }
    // Spawn errors and timeouts are worker failures, independent of the file.
    if (lastAttempt && typeof failure.code === 'number') {
      const detail = failure.stderr?.split('\n').find((line) => /\[(error|fatal)\]/.test(line)) ?? failure.message
      await db.transaction(async (tx) => {
        const [failed] = await tx.update(mediaFiles).set({
          probeError: (LOUDNESS_ERROR_PREFIX + detail.trim()).slice(0, 500),
          loudnessLufs: null, truePeakDb: null,
          decodedFrames: null, decodedRate: null, primingFrames: null, paddingFrames: null,
          updatedAt: new Date(),
        }).where(sameFile).returning({ releaseId: mediaFiles.releaseId })
        if (failed?.releaseId) await tx.delete(releaseLoudness).where(eq(releaseLoudness.releaseId, failed.releaseId))
      })
    }
    throw error
  }
  const { lufs, ...measurement } = result
  // Backfilling lengths alone does not make the existing album meter result stale.
  // The loudness columns are PostgreSQL real values, so compare at their precision.
  const loudnessChanged = file.loudnessLufs === null || file.truePeakDb === null
    || Math.fround(file.loudnessLufs) !== Math.fround(lufs)
    || Math.fround(file.truePeakDb) !== Math.fround(result.truePeakDb)
  const [measured] = await db.update(mediaFiles).set({
    ...measurement, loudnessLufs: lufs, probeError: null, ...(loudnessChanged && { updatedAt: new Date() }),
  }).where(sameFile).returning({ releaseId: mediaFiles.releaseId })
  return loudnessChanged ? measured?.releaseId ?? null : null
}

/**
 * The `loudness.album` job: one measurement across every present file of the release, in
 * track order. Waits (returns) until all of them have their own loudness, since each
 * measurement queues this job again. Removes the row when no file is left.
 */
export async function measureRelease(releaseId: string): Promise<void> {
  const computedAt = new Date()
  const files = await db.select({
    rootId: mediaFiles.rootId, relPath: mediaFiles.relPath, channels: mediaFiles.channels,
    loudnessLufs: mediaFiles.loudnessLufs, truePeakDb: mediaFiles.truePeakDb, probeError: mediaFiles.probeError,
  }).from(mediaFiles)
    .leftJoin(releaseTracks, eq(releaseTracks.id, mediaFiles.releaseTrackId))
    .where(and(eq(mediaFiles.releaseId, releaseId), isNull(mediaFiles.missingSince)))
    .orderBy(sql`${releaseTracks.disc} nulls last`, sql`${releaseTracks.position} nulls last`, asc(mediaFiles.relPath))
  if (files.length === 0 || files.some((file) => isLoudnessError(file.probeError))) {
    await db.delete(releaseLoudness).where(eq(releaseLoudness.releaseId, releaseId))
    return
  }
  let truePeakDb = -Infinity
  for (const file of files) {
    if (file.loudnessLufs === null || file.truePeakDb === null) return
    truePeakDb = Math.max(truePeakDb, file.truePeakDb)
  }
  const paths = await Promise.all(files.map(libraryPath))
  const loudnessLufs = await measureAlbumLoudness(paths, files.every((file) => file.channels === 1))
  const row = { loudnessLufs, truePeakDb, fileCount: files.length, computedAt }
  await db.insert(releaseLoudness).values({ releaseId, ...row })
    .onConflictDoUpdate({ target: releaseLoudness.releaseId, set: row })
}
