import { stat } from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { eq } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { libraryRoots, mediaFiles, type FileTags } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { runFfprobe } from '../../lib/ffmpeg.js'
import { pickEmbeddedPicture, storeEmbeddedPicture, type EmbeddedPicture } from '../artwork/index.js'
import { groupKeyFor } from './grouping.js'
import { reportProbeProgress } from './progress.js'
import { fromFfprobe, normalizeTags, rawTags, readGains, technicalFromFormat, type Gains, type Technical } from './tags.js'

export type ProbeJob = { fileId: string }

/** Analysis is heavy and waits behind tag reading. */
export const TAG_VERSION = 1
export const ANALYZE_PRIORITY = -10

type Probed = { technical: Technical; tags: FileTags; gains: Gains; picture?: EmbeddedPicture }

async function ffprobe(file: string, extension: string, size: number) {
  return fromFfprobe(await runFfprobe(file).catch(() => null), extension, size)
}

/**
 * Reads tags and technical details. music-metadata does the work; ffprobe fills in the
 * duration when it is missing and takes over entirely when music-metadata cannot parse
 * the file. Returns an error message when neither can read it.
 */
async function read(file: string, size: number): Promise<Probed | string> {
  const extension = path.extname(file).slice(1)
  try {
    const metadata = await parseFile(file)
    const raw = rawTags(Object.values(metadata.native))
    const technical = technicalFromFormat(metadata.format, extension, size)
    if (technical.durationMs === 0 || technical.codec === 'unknown') {
      const fallback = await ffprobe(file, extension, size)
      // Headers without a readable stream (a truncated or mislabeled file) cannot play.
      if (!fallback && technical.durationMs === 0) return 'Unreadable audio file: no audio stream'
      if (fallback) {
        technical.durationMs ||= fallback.technical.durationMs
        if (technical.codec === 'unknown') technical.codec = fallback.technical.codec
      }
    }
    return { technical, tags: normalizeTags(metadata.common, raw), gains: readGains(metadata.common, raw), picture: pickEmbeddedPicture(metadata.common.picture) }
  } catch (error) {
    const fallback = await ffprobe(file, extension, size)
    if (!fallback) return `Unreadable audio file: ${(error as Error).message}`.slice(0, 500)
    return { technical: fallback.technical, tags: normalizeTags({}, fallback.raw), gains: readGains({}, fallback.raw) }
  }
}

/**
 * Reads one file's tags and technical details, stores its embedded picture, sets
 * `probe_stage` 1 and the group key, then queues ingest for the group (and for the group
 * it left, when it moved) and the low-priority analysis.
 *
 * A file nothing can read gets `probe_error` and is left alone until it changes on disk;
 * the job does not fail, so it is not retried.
 */
export async function probeFile(job: ProbeJob) {
  await probe(job)
}

/** A verified edit preserves the known audio hash. Commit the new groups together. */
export function probeTagEdit(job: ProbeJob, tx: Transaction, rematch: boolean) {
  return probe(job, { tx, rematch })
}

async function probe({ fileId }: ProbeJob, edit?: { tx: Transaction; rematch: boolean }) {
  const executor = edit?.tx ?? db
  const [row] = await executor.select({ file: mediaFiles, rootPath: libraryRoots.path }).from(mediaFiles)
    .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(eq(mediaFiles.id, fileId))
  if (!row || row.file.missingSince) return
  const { file } = row
  const absolute = path.join(row.rootPath, file.relPath)
  // Gone since the scan: the next scan marks it missing.
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile()) return
  const mtime = new Date(Math.floor(info.mtimeMs))
  const unchanged = file.probeStage >= 1 && file.size === info.size && file.mtime.getTime() === mtime.getTime()
  if (!edit && unchanged && file.tagVersion >= TAG_VERSION) return

  const probed = await read(absolute, info.size)
  if (typeof probed === 'string') {
    await executor.update(mediaFiles).set({ probeError: probed, size: info.size, mtime, updatedAt: new Date() }).where(eq(mediaFiles.id, fileId))
    if (!edit) reportProbeProgress(file.rootId)
    return probed
  }
  const asset = probed.picture ? await storeEmbeddedPicture(fileId, probed.picture) : null
  const groupKey = groupKeyFor(file.rootId, file.relPath, probed.tags)
  await executor.update(mediaFiles).set({
    ...probed.technical,
    size: info.size,
    mtime,
    tags: probed.tags,
    embeddedArtAssetId: asset?.id ?? null,
    tagTrackGainDb: probed.gains.trackGainDb,
    tagTrackPeak: probed.gains.trackPeak,
    tagAlbumGainDb: probed.gains.albumGainDb,
    tagAlbumPeak: probed.gains.albumPeak,
    groupKey,
    tagVersion: TAG_VERSION,
    probeStage: unchanged || edit ? Math.max(1, file.probeStage) : 1,
    ...(edit?.rematch && !file.matchLocked ? { matchStatus: 'pending', matchConfidence: null, matchSource: 'tags' } : {}),
    probeError: null,
    updatedAt: new Date(),
  }).where(eq(mediaFiles.id, fileId))

  for (const key of new Set([groupKey, file.groupKey])) {
    if (key) await enqueue('library.ingest', { rootId: file.rootId, groupKey: key }, { singletonKey: key, tx: edit?.tx })
  }
  if ((!edit && !unchanged) || file.probeStage < 2) await enqueue('library.analyze', { fileId }, { singletonKey: fileId, priority: ANALYZE_PRIORITY, tx: edit?.tx })
  if (!edit) reportProbeProgress(file.rootId)
}
