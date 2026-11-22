import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
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

/** Stored as the true peak of digital silence, which ebur128 reports as -inf. */
const SILENT_PEAK_DB = -144

const number = String.raw`(-?inf|nan|-?\d+(?:\.\d+)?)`

function parseLevel(text: string): number {
  const lower = text.toLowerCase()
  if (lower === 'nan') return Number.NaN
  if (lower.endsWith('inf')) return lower.startsWith('-') ? -Infinity : Infinity
  return Number(text)
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
  const integrated = new RegExp(String.raw`\bI:\s+${number}\s+LUFS`, 'i').exec(summary)
  const peak = new RegExp(String.raw`\bPeak:\s+${number}\s+dB(?:FS|TP)`, 'i').exec(summary)
  if (!integrated?.[1] || !peak?.[1]) return null
  const lufs = parseLevel(integrated[1])
  const truePeakDb = parseLevel(peak[1])
  return {
    lufs: Number.isFinite(lufs) && lufs > SILENT_LUFS ? lufs : SILENT_LUFS,
    truePeakDb: Number.isFinite(truePeakDb) ? truePeakDb : SILENT_PEAK_DB,
  }
}

const meter = 'ebur128=peak=true:framelog=verbose'

/** Runs ffmpeg with the given inputs and filter arguments, and parses the ebur128 summary. */
async function runMeter(args: string[]): Promise<Loudness> {
  // Per-frame lines go to the verbose level, so at `info` only the summary is logged.
  const { stderr } = await exec(getConfig().FFMPEG_PATH, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', ...args, '-f', 'null', '-'], {
    timeout: 60 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const result = parseEbur128(stderr)
  if (!result) throw new Error('ffmpeg printed no loudness summary')
  return result
}

/** EBU R128 integrated loudness and true peak of one file's first audio stream. */
export function measureLoudness(file: string): Promise<Loudness> {
  return runMeter([...audioInput(file), '-map', '0:a:0', '-af', meter])
}

/**
 * EBU R128 loudness of several files played back to back, as one programme: the files
 * are decoded and joined by the concat filter, so gating applies to the whole album.
 * Every input is brought to 48 kHz and one channel layout (mono only if all are mono)
 * because concat needs matching formats.
 */
export function measureAlbumLoudness(files: string[], allMono: boolean): Promise<Loudness> {
  const format = `aresample=48000,aformat=sample_fmts=flt:channel_layouts=${allMono ? 'mono' : 'stereo'}`
  const chains = files.map((_, index) => `[${index}:a:0]${format}[a${index}]`)
  const joined = `${files.map((_, index) => `[a${index}]`).join('')}concat=n=${files.length}:v=0:a=1,${meter}`
  return runMeter([...files.flatMap(audioInput), '-filter_complex', [...chains, joined].join(';')])
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * The `loudness.measure` job. A file that has gone from disk is left for the scanner; one
 * ffmpeg cannot read is retried, and on the last attempt stored as silent so the sweep does
 * not pick it up forever. Returns the file's release so the caller can queue album loudness.
 */
export async function measureFile(fileId: string, lastAttempt: boolean): Promise<string | null> {
  const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.id, fileId), isNull(mediaFiles.missingSince)))
  if (!file) return null
  let result: Loudness
  try {
    const input = await libraryPath(file)
    // execFile reports a missing input as an ffmpeg failure, so check first.
    await access(input)
    result = await measureLoudness(input)
  } catch (error) {
    if (isMissing(error)) return null
    if (!lastAttempt) throw error
    result = { lufs: SILENT_LUFS, truePeakDb: SILENT_PEAK_DB }
  }
  await db.update(mediaFiles).set({ loudnessLufs: result.lufs, truePeakDb: result.truePeakDb, updatedAt: new Date() })
    .where(eq(mediaFiles.id, fileId))
  return file.releaseId
}

/**
 * The `loudness.album` job: one measurement across every present file of the release, in
 * track order. Waits (returns) until all of them have their own loudness, since each
 * measurement queues this job again. Removes the row when no file is left.
 */
export async function measureRelease(releaseId: string): Promise<void> {
  const files = await db.select({
    id: mediaFiles.id, rootId: mediaFiles.rootId, relPath: mediaFiles.relPath, channels: mediaFiles.channels, loudnessLufs: mediaFiles.loudnessLufs,
  }).from(mediaFiles)
    .leftJoin(releaseTracks, eq(releaseTracks.id, mediaFiles.releaseTrackId))
    .where(and(eq(mediaFiles.releaseId, releaseId), isNull(mediaFiles.missingSince)))
    .orderBy(sql`${releaseTracks.disc} nulls last`, sql`${releaseTracks.position} nulls last`, asc(mediaFiles.relPath))
  if (files.length === 0) {
    await db.delete(releaseLoudness).where(eq(releaseLoudness.releaseId, releaseId))
    return
  }
  if (files.some((file) => file.loudnessLufs === null)) return
  const paths = await Promise.all(files.map((file) => libraryPath(file)))
  const result = await measureAlbumLoudness(paths, files.every((file) => file.channels === 1))
  const row = { loudnessLufs: result.lufs, truePeakDb: result.truePeakDb, fileCount: files.length, computedAt: new Date() }
  await db.insert(releaseLoudness).values({ releaseId, ...row })
    .onConflictDoUpdate({ target: releaseLoudness.releaseId, set: row })
}
