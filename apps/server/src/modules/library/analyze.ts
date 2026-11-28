import { access } from 'node:fs/promises'
import path from 'node:path'
import { INCOMING_FOLDER } from '@squirmy/contracts'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { audioHash } from '../../lib/ffmpeg.js'
import { lockCatalog, removeOrphans } from './cleanup.js'
import { ANALYZE_PRIORITY } from './probe.js'

export type AnalyzeJob = { fileId: string }

const exists = (file: string) => access(file).then(() => true, () => false)

/**
 * Computes the file's audio hash and sets `probe_stage` 2, then queues loudness
 * measurement (owned by the loudness module).
 *
 * The hash is how a moved or renamed file keeps its identity. When another row has the
 * same hash and its file is gone (marked missing, or not yet noticed by the scan), the
 * file is that row: the old row takes the new path and the new row is deleted. The old
 * row's id, links and match state survive, so everything that points at it still works.
 */
export async function analyzeFile({ fileId }: AnalyzeJob) {
  const [row] = await db.select({ file: mediaFiles, rootPath: libraryRoots.path }).from(mediaFiles)
    .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(eq(mediaFiles.id, fileId))
  if (!row || row.file.missingSince || row.file.probeStage !== 1) return
  const absolute = path.join(row.rootPath, row.file.relPath)
  let hash: string
  try {
    hash = await audioHash(absolute)
  } catch (error) {
    if (!(await exists(absolute))) return
    await db.update(mediaFiles).set({ probeError: `Audio analysis failed: ${(error as Error).message}`.slice(0, 500), updatedAt: new Date() })
      .where(eq(mediaFiles.id, fileId))
    return
  }

  const outcome = await db.transaction(async (tx) => {
    await lockCatalog(tx)
    const [current] = await tx.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
    if (!current || current.missingSince) return null
    const twins = await tx.select({ file: mediaFiles, rootPath: libraryRoots.path }).from(mediaFiles)
      .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
      .where(and(eq(mediaFiles.audioHash, hash), ne(mediaFiles.id, fileId)))
      .orderBy(sql`${mediaFiles.missingSince} is null`, desc(mediaFiles.missingSince))
    let original: typeof mediaFiles.$inferSelect | undefined
    for (const twin of twins) {
      if (twin.file.missingSince || !(await exists(path.join(twin.rootPath, twin.file.relPath)))) {
        original = twin.file
        break
      }
    }
    if (!original) {
      await tx.update(mediaFiles).set({ audioHash: hash, probeStage: 2, probeError: null, updatedAt: new Date() }).where(eq(mediaFiles.id, fileId))
      return { fileId, groups: [] }
    }

    await tx.delete(mediaFiles).where(eq(mediaFiles.id, current.id))
    await tx.update(mediaFiles).set({
      rootId: current.rootId,
      relPath: current.relPath,
      size: current.size,
      mtime: current.mtime,
      container: current.container,
      codec: current.codec,
      lossless: current.lossless,
      bitrate: current.bitrate,
      sampleRate: current.sampleRate,
      bitDepth: current.bitDepth,
      channels: current.channels,
      durationMs: current.durationMs,
      tags: current.tags,
      tagVersion: current.tagVersion,
      embeddedArtAssetId: current.embeddedArtAssetId,
      tagTrackGainDb: current.tagTrackGainDb,
      tagTrackPeak: current.tagTrackPeak,
      tagAlbumGainDb: current.tagAlbumGainDb,
      tagAlbumPeak: current.tagAlbumPeak,
      groupKey: current.groupKey,
      // A provider delivery someone moved out of `_Fetched/` (or into another root) was
      // moved to be kept: from now on it is theirs, not cache that eviction may delete. The
      // scanner's own row says which: under a managed root's `_Fetched/` it is cache too.
      // `_Incoming/` is left to the import that owns the folder.
      ...(original.cached && !current.cached && !current.relPath.startsWith(`${INCOMING_FOLDER}/`) ? { source: current.source } : {}),
      audioHash: hash,
      probeStage: 2,
      probeError: null,
      missingSince: null,
      updatedAt: new Date(),
    }).where(eq(mediaFiles.id, original.id))
    await removeOrphans(tx, { albumIds: [current.albumId], releaseIds: [current.releaseId], recordingIds: [current.recordingId] })
    return {
      fileId: original.id,
      groups: [
        { rootId: current.rootId, groupKey: current.groupKey },
        { rootId: original.rootId, groupKey: original.groupKey },
      ],
    }
  })
  if (!outcome) return

  // Both groups changed membership: the new one gained the old row, the old one lost it.
  for (const { rootId, groupKey } of outcome.groups) {
    if (groupKey) await enqueue('library.ingest', { rootId, groupKey }, { singletonKey: groupKey })
  }
  // Handled by the loudness module.
  await enqueue('loudness.measure', { fileId: outcome.fileId }, { singletonKey: outcome.fileId, priority: ANALYZE_PRIORITY })
}
