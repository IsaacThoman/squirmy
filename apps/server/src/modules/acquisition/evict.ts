/**
 * The provider cache: every file a provider delivered (`media_files.cached`) and its limit.
 *
 * The policy's `storageQuotaBytes` is the cache limit. Reaching it never refuses a fetch:
 * `acquisition.evict` (hourly, and queued when a job completes or a delivery arrives while
 * the cache is over the limit) deletes the least recently used unpinned cached files until
 * the cache is under 90% of the limit. 0 means unlimited and nothing is evicted.
 *
 * - **Least recently used** is the later of the file's recording's last play (by anyone)
 *   and the file's arrival, so a file fetched a minute ago is not taken before one played
 *   last month.
 * - **Pinned** files are never evicted (userdata/pins.ts): saved, liked, in a playlist or a
 *   stored queue, or played in the last day. Also spared: files that arrived in the last
 *   hour (a device may be downloading them) and files of imports still running.
 * - **Deleting** a file removes it from disk and its `media_files` row, then the local-only
 *   catalog rows it leaves unused, exactly as a purge of a missing file would. Catalog
 *   albums and recordings stay, so the track goes back to `on_demand`.
 *
 * Folders: a file under `_Fetched/` or `_Incoming/` takes its sidecars (cover, lyrics) and
 * then its folder with it once no other file is there. Anywhere else (a delivery filed
 * before `_Fetched` existed and not organized since) only the audio file is deleted.
 *
 * `discardUnrequested` uses the same deletion for delivered files that are not what the
 * job asked for (docs/provider-protocol.md, "Verification"): they are not kept for review.
 */
import { readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { FETCHED_FOLDER, INCOMING_FOLDER, queryKeys, type AcquisitionUsage } from '@squirmy/contracts'
import { and, eq, or, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { imports, libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { incomingFolder } from '../imports/service.js'
import { fileKind } from '../imports/paths.js'
import { lockCatalog, removeOrphans } from '../library/cleanup.js'
import { pinnedFile, queuedRecordings } from '../userdata/pins.js'
import { getAcquisitionPolicy } from './policy.js'
import { invalidateRecordings } from './resolve.js'

/** Eviction stops once the cache is this share of the limit, so it does not run on every delivery. */
export const EVICT_TO = 0.9

const timing = {
  /** Files younger than this are never evicted. */
  graceMs: 60 * 60_000,
  /** How long `cachedBytes` is reused between deliveries. */
  usageCacheMs: 5_000,
}

/** Overrides the eviction timings in tests. */
export function configureEviction(options: Partial<typeof timing>) {
  Object.assign(timing, options)
}

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

const present = sql`${mediaFiles.missingSince} is null`
const fileLinks = { recordingId: sql`${mediaFiles.recordingId}`, albumId: sql`${mediaFiles.albumId}` }

let usageCache: { bytes: number; at: number } | undefined

/** Bytes of present cached files. Reused for a few seconds: deliveries ask on every upload. */
export async function cachedBytes({ fresh = false } = {}): Promise<number> {
  if (!fresh && usageCache && Date.now() - usageCache.at < timing.usageCacheMs) return usageCache.bytes
  const [row] = await db.select({ bytes: sql<string>`coalesce(sum(${mediaFiles.size}), 0)` }).from(mediaFiles)
    .where(and(eq(mediaFiles.cached, true), present))
  usageCache = { bytes: Number(row?.bytes ?? 0), at: Date.now() }
  return usageCache.bytes
}

/** `GET /admin/acquisition/usage`. */
export async function cacheUsage(): Promise<AcquisitionUsage> {
  const { storageQuotaBytes } = await getAcquisitionPolicy()
  const queued = await queuedRecordings()
  const [row] = await db.select({
    files: sql<number>`count(*)::int`,
    bytes: sql<string>`coalesce(sum(${mediaFiles.size}), 0)`,
    pinned: sql<string>`coalesce(sum(${mediaFiles.size}) filter (where ${pinnedFile(fileLinks, queued)}), 0)`,
  }).from(mediaFiles).where(and(eq(mediaFiles.cached, true), present))
  return { cachedFiles: row?.files ?? 0, cachedBytes: Number(row?.bytes ?? 0), pinnedBytes: Number(row?.pinned ?? 0), limitBytes: storageQuotaBytes }
}

/** Queues `acquisition.evict` when the cache is over its limit. Cheap enough to call after every delivery. */
export async function evictWhenOver() {
  const { storageQuotaBytes } = await getAcquisitionPolicy()
  if (storageQuotaBytes === 0 || await cachedBytes() <= storageQuotaBytes) return
  await enqueue('acquisition.evict', {}, { singletonKey: 'evict' })
}

type Candidate = { id: string; size: number }

/**
 * `acquisition.evict`: deletes least recently used, unpinned cached files until the cache
 * is under {@link EVICT_TO} of the limit. Returns what it deleted.
 */
export async function evictCache(): Promise<{ files: number; bytes: number }> {
  const { storageQuotaBytes } = await getAcquisitionPolicy()
  const evicted = { files: 0, bytes: 0 }
  if (storageQuotaBytes === 0) return evicted
  let usage = await cachedBytes({ fresh: true })
  if (usage <= storageQuotaBytes) return evicted
  const target = Math.floor(storageQuotaBytes * EVICT_TO)
  const queued = await queuedRecordings()
  const skipped = new Set<string>()
  const recordings = new Set<string>()
  while (usage > target) {
    const page = await candidates(queued, [...skipped])
    if (page.length === 0) break
    for (const candidate of page) {
      if (usage <= target) break
      const deleted = await deleteCachedFile(candidate.id, { queued }).catch((error: unknown) => {
        report(error)
        return null
      })
      if (!deleted) {
        skipped.add(candidate.id)
        continue
      }
      usage -= deleted.size
      evicted.files += 1
      evicted.bytes += deleted.size
      if (deleted.recordingId) recordings.add(deleted.recordingId)
    }
  }
  usageCache = undefined
  if (evicted.files > 0) await announceDeleted([...recordings])
  return evicted
}

/** The next unpinned cached files to evict, least recently used first. */
async function candidates(queued: readonly string[], skipped: readonly string[]): Promise<Candidate[]> {
  const settled = sql`(${mediaFiles.importId} is null or exists (
    select 1 from imports i where i.id = ${mediaFiles.importId} and i.status in ('completed', 'failed')))`
  const lastUsed = sql`greatest(${mediaFiles.addedAt}, (select max(p.started_at) from plays p where p.recording_id = ${mediaFiles.recordingId}))`
  return db.select({ id: mediaFiles.id, size: mediaFiles.size }).from(mediaFiles).where(and(
    eq(mediaFiles.cached, true), present, settled,
    sql`${mediaFiles.addedAt} < ${new Date(Date.now() - timing.graceMs)}`,
    sql`not ${pinnedFile(fileLinks, queued)}`,
    skipped.length > 0 ? sql`${mediaFiles.id} <> all(${uuidArray(skipped)})` : undefined,
  )).orderBy(lastUsed, mediaFiles.id).limit(100)
}

type Deleted = { size: number; recordingId: string | null; albumId: string | null }

/**
 * Deletes one cached file from disk and the database. With `queued`, only while it is
 * still unpinned (checked again under the file's row lock); without, whatever holds it
 * (a delivery that is not what was asked for). Null when the file is gone, no longer
 * cache, or pinned. Throws when the file cannot be deleted from disk; its row is kept.
 */
export async function deleteCachedFile(fileId: string, { queued }: { queued?: readonly string[] } = {}): Promise<Deleted | null> {
  const removed = await db.transaction(async (tx) => {
    // Ingest, matching and the purge relink and delete the same rows; take their lock first.
    await lockCatalog(tx)
    const [row] = await tx.select({ file: mediaFiles, rootPath: libraryRoots.path }).from(mediaFiles)
      .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
      .where(and(eq(mediaFiles.id, fileId), eq(mediaFiles.cached, true), present, queued ? sql`not ${pinnedFile(fileLinks, queued)}` : undefined))
      .for('update', { of: mediaFiles })
    if (!row) return null
    await unlink(path.join(row.rootPath, row.file.relPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await tx.delete(mediaFiles).where(eq(mediaFiles.id, fileId))
    await removeOrphans(tx, { albumIds: [row.file.albumId], releaseIds: [row.file.releaseId], recordingIds: [row.file.recordingId] })
    return row
  })
  if (!removed) return null
  usageCache = undefined
  await tidyFolder(removed.file.rootId, removed.rootPath, removed.file.relPath).catch(report)
  return { size: removed.file.size, recordingId: removed.file.recordingId, albumId: removed.file.albumId }
}

/**
 * After deleting `relPath`: inside `_Fetched/` or `_Incoming/`, removes the folder's
 * sidecars and the folder once no other file of the root is there (by row or on disk),
 * then empty parents up to the top folder. Elsewhere it changes nothing more.
 */
async function tidyFolder(rootId: string, rootPath: string, relPath: string) {
  const top = relPath.split('/')[0]
  if (top !== FETCHED_FOLDER && top !== INCOMING_FOLDER) return
  let folder = path.posix.dirname(relPath)
  if (folder === top) return
  const [other] = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, rootId), sql`starts_with(${mediaFiles.relPath}, ${`${folder}/`})`)).limit(1)
  if (other) return
  const absolute = path.join(rootPath, folder)
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null)
  if (!entries) return
  // Only plain sidecars go: a folder holding audio, other files or subfolders is left as it is.
  if (entries.some((entry) => !entry.isFile() || fileKind(entry.name) !== 'sidecar')) return
  for (const entry of entries) await unlink(path.join(absolute, entry.name)).catch(() => {})
  while (folder !== top && folder !== '.') {
    try {
      await rmdir(path.join(rootPath, folder))
    } catch {
      return
    }
    folder = path.posix.dirname(folder)
  }
}

async function announceDeleted(recordingIds: string[]) {
  await invalidateRecordings(recordingIds)
  await invalidate('all', [queryKeys.library(), queryKeys.home()])
  await invalidate('admins', [queryKeys.admin()])
}

/**
 * Deletes the delivered files of an ended job's import that are not a recording the job
 * asked for (after following merges): wrong songs, extras, files nothing identified. A
 * delivery is never left for review, and a file the provider sent under another track's
 * identity never stays to play as that track. Only provider-delivered files of the job's
 * own import are touched; library files the import kept instead of duplicates are not, and
 * neither are files an admin fixed the match of. Does nothing while the import is still
 * running. Returns how many files it deleted.
 */
export async function discardUnrequested(job: { recordingIds: string[]; importId: string | null }): Promise<number> {
  if (!job.importId) return 0
  const [done] = await db.select({ status: imports.status, rootId: imports.targetRootId }).from(imports).where(eq(imports.id, job.importId))
  if (!done || (done.status !== 'completed' && done.status !== 'failed')) return 0
  const files = await db.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId }).from(mediaFiles).where(and(
    eq(mediaFiles.cached, true), present, eq(mediaFiles.matchLocked, false),
    or(
      eq(mediaFiles.importId, job.importId),
      done.rootId ? and(eq(mediaFiles.rootId, done.rootId), sql`starts_with(${mediaFiles.relPath}, ${`${incomingFolder(job.importId)}/`})`) : undefined,
    ),
  ))
  if (files.length === 0) return 0
  const resolved = await resolveMerged('recordings', [...job.recordingIds, ...files.flatMap((file) => file.recordingId ? [file.recordingId] : [])])
  const target = (id: string) => resolved.get(id) ?? id
  const wanted = new Set(job.recordingIds.map(target))
  const unwanted = files.filter((file) => !file.recordingId || !wanted.has(target(file.recordingId)))
  const recordings: string[] = []
  let deleted = 0
  for (const file of unwanted) {
    const gone = await deleteCachedFile(file.id).catch((error: unknown) => {
      report(error)
      return null
    })
    if (!gone) continue
    deleted += 1
    if (gone.recordingId) recordings.push(gone.recordingId)
  }
  if (deleted > 0) await announceDeleted(recordings)
  return deleted
}
