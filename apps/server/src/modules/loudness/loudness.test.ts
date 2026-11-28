import { execFile } from 'node:child_process'
import { link, mkdtemp, rm, stat, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles, releaseLoudness } from '../../database/schema.js'
import { drainJobs, enqueue, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { makeTone, writeHostileInputs } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { loudnessModule } from './index.js'
import { measureAlbumLoudness, measureLoudness, parseEbur128 } from './measure.js'
import { normalizationFor, SILENT_LUFS } from './normalization.js'

const run = promisify(execFile)

/** What the ffmpeg command line prints for a file, read with a separate, plain parser. */
async function cliLoudness(file: string) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 })
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  return {
    lufs: Number(/I:\s+(\S+) LUFS/.exec(summary)![1]),
    truePeakDb: Number(/Peak:\s+(\S+) dBFS/.exec(summary)![1]),
  }
}

describe('ebur128 output', () => {
  it('reads the last summary and turns silence into sentinels', () => {
    const log = (integrated: string, peak: string) => `
[Parsed_ebur128_0 @ 0x1] t: 0.1 TARGET:-23 LUFS M:-120.7 S:-120.7 I: -70.0 LUFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         ${integrated} LUFS
    Threshold: -33.0 LUFS

  True peak:
    Peak:      ${peak} dBFS
`
    expect(parseEbur128(log('-23.4', '-1.2'))).toEqual({ lufs: -23.4, truePeakDb: -1.2 })
    expect(parseEbur128(log('-12.0', '0.4').replace('Summary:', 'Summary:\n  I: -99.0 LUFS') + log('-9.5', '1.5'))).toEqual({ lufs: -9.5, truePeakDb: 1.5 })
    expect(parseEbur128(log('-70.0', '-inf'))).toEqual({ lufs: SILENT_LUFS, truePeakDb: -144 })
    expect(parseEbur128(log('nan', '-80.5'))).toEqual({ lufs: SILENT_LUFS, truePeakDb: -80.5 })
    expect(parseEbur128('no summary here')).toBeNull()
  })
})

describe('loudness', () => {
  useTestDatabase()
  let root: string
  // Quiet tones that still clear ebur128's -70 LUFS absolute gate.
  const tones = { soft: '', loud: '', silent: '', short: '' }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'squirmy-loudness-'))
    tones.soft = await makeTone(root, { path: 'a/01 soft.flac', durationSec: 4, frequency: 1000, volumeDb: -30 })
    tones.loud = await makeTone(root, { path: 'a/02 loud.flac', durationSec: 4, frequency: 1000, volumeDb: -20 })
    tones.silent = await makeTone(root, { path: 'a/03 silent.flac', durationSec: 2, volumeDb: -150 })
    tones.short = await makeTone(root, { path: 'a/04 short.flac', durationSec: 0.2, volumeDb: -20 })
    await loudnessModule.jobs!(jobs)
    await startJobs({ work: true })
  })
  afterAll(async () => {
    await stopJobs()
    await rm(root, { recursive: true, force: true })
  })

  it('measures tones like the ffmpeg command line does', async () => {
    const soft = await measureLoudness(tones.soft)
    const loud = await measureLoudness(tones.loud)
    expect(loud.lufs - soft.lufs).toBeCloseTo(10, 1)
    for (const [file, measured] of [[tones.soft, soft], [tones.loud, loud]] as const) {
      const cli = await cliLoudness(file)
      expect(Math.abs(measured.lufs - cli.lufs)).toBeLessThanOrEqual(0.2)
      expect(Math.abs(measured.truePeakDb - cli.truePeakDb)).toBeLessThanOrEqual(0.2)
    }
    const silent = await measureLoudness(tones.silent)
    expect(silent.lufs).toBe(SILENT_LUFS)
    expect(silent.truePeakDb).toBeLessThan(-120)
    expect((await measureLoudness(tones.short)).lufs).toBe(SILENT_LUFS)
  })

  it('refuses a file whose content makes ffmpeg read another file', async () => {
    await makeTone(root, { path: 'hostile/real.flac', durationSec: 4, frequency: 1000, volumeDb: -30 })
    const { concat } = await writeHostileInputs(path.join(root, 'hostile'), { target: 'real.flac', url: 'http://127.0.0.1:9' })
    await expect(measureLoudness(concat)).rejects.toThrow(/not on whitelist/)
    await expect(measureAlbumLoudness([tones.soft, concat], false)).rejects.toThrow(/not on whitelist/)
  })

  it('gates an album as one programme rather than averaging tracks', async () => {
    const soft = await measureLoudness(tones.soft)
    const loud = await measureLoudness(tones.loud)
    const album = await measureAlbumLoudness([tones.soft, tones.loud], false)
    const mean = (soft.lufs + loud.lufs) / 2
    expect(album).toBeGreaterThan(mean + 1)
    expect(album).toBeLessThan(loud.lufs)
    // Energy average of two equal-length tones 10 LU apart.
    expect(album).toBeCloseTo(loud.lufs + 10 * Math.log10((1 + 0.1) / 2), 1)
  })

  it('measures a mixed-format box set with tracks shorter than a gating block', async () => {
    const tone = { frequency: 1000, volumeDb: -30 }
    const flac = await makeTone(root, { ...tone, path: 'box/short.flac', durationSec: 0.1 })
    const wav = await makeTone(root, { ...tone, path: 'box/short.wav', durationSec: 0.1 })
    const files = await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      const source = index % 2 === 0 ? flac : wav
      const file = path.join(root, 'box', `track '${index}'${path.extname(source)}`)
      await link(source, file)
      return file
    }))
    const continuous = await makeTone(root, { ...tone, path: 'box/continuous.wav', durationSec: files.length / 10 })

    expect((await measureLoudness(flac)).lufs).toBe(SILENT_LUFS)
    expect(await measureAlbumLoudness(files, false)).toBeCloseTo((await cliLoudness(continuous)).lufs, 1)
  })

  it('records a truncated input as a failed job and measures the repaired file', async () => {
    const brokenRoot = path.join(root, 'broken')
    const tone = { path: 'truncated.wav', durationSec: 1, volumeDb: -30 }
    const damaged = await makeTone(brokenRoot, tone)
    await truncate(damaged, (await stat(damaged)).size - 1)
    await expect(measureLoudness(damaged)).rejects.toThrow(/corrupt|invalid/i)
    await expect(measureAlbumLoudness([tones.soft, damaged], false)).rejects.toThrow(/corrupt|invalid/i)

    const libraryRoot = await createLibraryRoot({ path: brokenRoot })
    const { tracks, releaseId } = await createAlbum({ owned: true, rootId: libraryRoot.id, tracks: [{ title: 'Truncated' }] })
    const fileId = tracks[0]!.fileId!
    await db.update(mediaFiles).set({ relPath: tone.path, loudnessLufs: -48, truePeakDb: -47 }).where(eq(mediaFiles.id, fileId))
    await db.insert(releaseLoudness).values({ releaseId, loudnessLufs: -48, truePeakDb: -47, fileCount: 1 })
    const readFile = async () => (await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId)))[0]!
    const attempts = () => db.execute(sql`
      select state, retry_count from pgboss.job where name = 'loudness.measure' and data->>'fileId' = ${fileId}`)

    await enqueue('loudness.measure', { fileId }, { singletonKey: fileId })
    await drainJobs()
    const failed = await readFile()
    expect(failed).toMatchObject({ loudnessLufs: null, truePeakDb: null, probeError: expect.stringMatching(/^Loudness measurement failed: .*corrupt/i) })
    expect(await normalizationFor(failed)).toBeNull()
    expect(await attempts()).toEqual([{ state: 'failed', retry_count: 2 }])

    await enqueue('loudness.sweep', {})
    await drainJobs()
    expect(await attempts()).toHaveLength(1)

    await rm(damaged)
    await makeTone(brokenRoot, tone)
    // When the scanner sees new content, it clears the error and queues the library pipeline.
    await db.update(mediaFiles).set({ probeError: null, probeStage: 2, mtime: (await stat(damaged)).mtime }).where(eq(mediaFiles.id, fileId))
    await enqueue('loudness.sweep', {})
    await drainJobs()
    const repaired = await readFile()
    expect(repaired.probeError).toBeNull()
    expect(repaired.loudnessLufs).toBeGreaterThan(SILENT_LUFS)
    expect(await normalizationFor(repaired)).toMatchObject({ trackGainDb: expect.any(Number), albumGainDb: expect.any(Number) })
  })

  it('sweeps, measures files and albums, and recomputes when the files change', async () => {
    const libraryRoot = await createLibraryRoot({ path: root })
    const album = await createAlbum({ owned: true, rootId: libraryRoot.id, tracks: [{ title: 'Soft' }, { title: 'Loud' }, { title: 'Silent' }] })
    const ids = album.tracks.map((track) => track.fileId!)
    const paths = ['a/01 soft.flac', 'a/02 loud.flac', 'a/03 silent.flac']
    for (const [index, id] of ids.entries()) {
      await db.update(mediaFiles).set({ relPath: paths[index]!, channels: 2 }).where(eq(mediaFiles.id, id))
    }
    const files = async () => db.select().from(mediaFiles).where(inArray(mediaFiles.id, ids)).orderBy(mediaFiles.relPath)
    const albumRow = async () => (await db.select().from(releaseLoudness).where(eq(releaseLoudness.releaseId, album.releaseId)))[0]

    await enqueue('loudness.sweep', {})
    await drainJobs({ timeoutMs: 60_000 })
    const [soft, loud, silent] = await files()
    expect(soft!.loudnessLufs).toBeCloseTo((await measureLoudness(tones.soft)).lufs, 1)
    expect(loud!.loudnessLufs! - soft!.loudnessLufs!).toBeCloseTo(10, 1)
    expect(silent!.loudnessLufs).toBe(SILENT_LUFS)
    const first = await albumRow()
    expect(first).toMatchObject({ fileCount: 3 })
    expect(first!.loudnessLufs).toBeCloseTo(await measureAlbumLoudness([tones.soft, tones.loud, tones.silent], false), 1)
    expect(first!.truePeakDb).toBeCloseTo(loud!.truePeakDb!, 1)

    // Nothing left to do: a second sweep changes nothing.
    await enqueue('loudness.sweep', {})
    await drainJobs({ timeoutMs: 60_000 })
    expect((await albumRow())!.computedAt).toEqual(first!.computedAt)

    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.id, ids[1]!))
    await enqueue('loudness.sweep', {})
    await drainJobs({ timeoutMs: 60_000 })
    const second = await albumRow()
    expect(second!.fileCount).toBe(2)
    expect(second!.loudnessLufs).toBeLessThan(first!.loudnessLufs - 3)

    await db.update(mediaFiles).set({ missingSince: new Date() }).where(inArray(mediaFiles.id, ids))
    await enqueue('loudness.sweep', {})
    await drainJobs({ timeoutMs: 60_000 })
    expect(await albumRow()).toBeUndefined()
  })

  it('prefers measured values, then tags, for track and album', async () => {
    const { releaseId } = await createAlbum({ tracks: [{ title: 'Any' }] })
    const none = { releaseId: null, loudnessLufs: null, truePeakDb: null, tagTrackGainDb: null, tagTrackPeak: null, tagAlbumGainDb: null, tagAlbumPeak: null }
    const tagged = { ...none, tagTrackGainDb: -4.5, tagTrackPeak: 0.9, tagAlbumGainDb: -5.5, tagAlbumPeak: 0.95 }

    expect(await normalizationFor(none)).toBeNull()
    expect(await normalizationFor(tagged)).toEqual({ trackGainDb: -4.5, trackPeak: 0.9, albumGainDb: -5.5, albumPeak: 0.95 })
    expect(await normalizationFor({ ...tagged, loudnessLufs: -12, truePeakDb: 0 }))
      .toEqual({ trackGainDb: -6, trackPeak: 1, albumGainDb: -5.5, albumPeak: 0.95 })
    // A silent measurement carries no gain; the tags still do.
    expect(await normalizationFor({ ...tagged, loudnessLufs: SILENT_LUFS, truePeakDb: -144 }))
      .toEqual({ trackGainDb: -4.5, trackPeak: 0.9, albumGainDb: -5.5, albumPeak: 0.95 })

    await db.insert(releaseLoudness).values({ releaseId, loudnessLufs: -14, truePeakDb: -6, fileCount: 1 })
    expect(await normalizationFor({ ...tagged, releaseId, loudnessLufs: -12, truePeakDb: 0 }))
      .toEqual({ trackGainDb: -6, trackPeak: 1, albumGainDb: -4, albumPeak: 0.501187 })
    expect(await normalizationFor({ ...none, releaseId }))
      .toEqual({ trackGainDb: null, trackPeak: null, albumGainDb: -4, albumPeak: 0.501187 })
  })
})
