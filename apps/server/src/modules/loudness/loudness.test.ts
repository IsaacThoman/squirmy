import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles, releaseLoudness } from '../../database/schema.js'
import { drainJobs, enqueue, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { makeTone } from '../../test/audio.js'
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
    tones.silent = await makeTone(root, { path: 'a/03 silent.flac', durationSec: 2 })
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
    expect((await measureLoudness(tones.silent)).lufs).toBe(SILENT_LUFS)
    expect((await measureLoudness(tones.short)).lufs).toBe(SILENT_LUFS)
  })

  it('gates an album as one programme rather than averaging tracks', async () => {
    const soft = await measureLoudness(tones.soft)
    const loud = await measureLoudness(tones.loud)
    const album = await measureAlbumLoudness([tones.soft, tones.loud], false)
    const mean = (soft.lufs + loud.lufs) / 2
    expect(album.lufs).toBeGreaterThan(mean + 1)
    expect(album.lufs).toBeLessThan(loud.lufs)
    // Energy average of two equal-length tones 10 LU apart.
    expect(album.lufs).toBeCloseTo(loud.lufs + 10 * Math.log10((1 + 0.1) / 2), 1)
    expect(album.truePeakDb).toBeCloseTo(loud.truePeakDb, 1)
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
    expect(first!.loudnessLufs).toBeCloseTo((await measureAlbumLoudness([tones.soft, tones.loud, tones.silent], false)).lufs, 1)

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
