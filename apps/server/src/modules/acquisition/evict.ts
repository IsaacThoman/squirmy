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
 *   hour (a device may be downloading them), files of imports still running, and anything
 *   outside a managed root (a read-only root is never written to).
 * - **Deleting** a file is `deleteLibraryFile` (library/delete.ts): from disk and its
 *   `media_files` row, then the local-only catalog rows it leaves unused, exactly as a
 *   purge of a missing file would. Catalog albums and recordings stay, so the track goes
 *   back to `on_demand`.
 *
 * Folders: a file under `_Fetched/` or `_Incoming/` takes its sidecars (cover, lyrics) and
 * then its folder with it once no other file is there. Anywhere else (a delivery filed
 * before `_Fetched` existed and not organized since) only the audio file is deleted.
 *
 * `discardUnrequested` uses the same deletion for delivered files that are not what the
 * job asked for (docs/provider-protocol.md, "Verification"): they are not kept for review.
 */
import { queryKeys, type AcquisitionUsage } from '@squirmy/contracts'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { imports, mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import { saversOf } from '../catalog/availability.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { incomingFolder } from '../imports/service.js'
import { deleteLibraryFile } from '../library/delete.js'
import { isPinned, pinnedFile, queuedRecordings } from '../userdata/pins.js'
import { getAcquisitionPolicy } from './policy.js'
import { announceAvailability } from './resolve.js'

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

/** How many candidates one ranking returns; a run that needs more ranks again. */
const RANK_BATCH = 5_000

/**
 * `acquisition.evict`: deletes least recently used, unpinned cached files until the cache
 * is under {@link EVICT_TO} of the limit. Each file's pins are checked again just before it
 * goes (`isPinned`), so a track queued or played since the run began is spared. When pinned
 * files alone are over the target, everything unpinned past its grace goes and the cache
 * stays over: the limit is then too small for what users hold on to. Returns what it deleted.
 */
export async function evictCache(): Promise<{ files: number; bytes: number }> {
  const { storageQuotaBytes } = await getAcquisitionPolicy()
  const evicted = { files: 0, bytes: 0 }
  if (storageQuotaBytes === 0) return evicted
  let usage = await cachedBytes({ fresh: true })
  if (usage <= storageQuotaBytes) return evicted
  const target = Math.floor(storageQuotaBytes * EVICT_TO)
  const skipped = new Set<string>()
  const recordings = new Set<string>()
  const albums = new Set<string>()
  while (usage > target) {
    const ranked = await candidates(await queuedRecordings(), [...skipped])
    if (ranked.length === 0) break
    for (const candidate of ranked) {
      if (usage <= target) break
      const deleted = await deleteCachedFile(candidate.id, { unpinned: true }).catch((error: unknown) => {
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
      if (deleted.albumId) albums.add(deleted.albumId)
    }
    if (ranked.length < RANK_BATCH) break
  }
  usageCache = undefined
  if (evicted.files > 0) await announceDeleted([...recordings], [...albums])
  return evicted
}

/** Cached files eviction may delete at all: only in a managed root, which the server files into. */
const deletable = sql`exists (select 1 from library_roots r where r.id = ${mediaFiles.rootId} and r.mode = 'managed')`

/**
 * Unpinned cached files past their grace, least recently used first, ranked once for many
 * deletions. Files of an import still running are not ready to judge.
 */
async function candidates(queued: readonly string[], skipped: readonly string[]): Promise<Candidate[]> {
  const settled = sql`(${mediaFiles.importId} is null or exists (
    select 1 from imports i where i.id = ${mediaFiles.importId} and i.status in ('completed', 'failed')))`
  const lastUsed = sql`greatest(${mediaFiles.addedAt}, (select max(p.started_at) from plays p where p.recording_id = ${mediaFiles.recordingId} and not p.skipped))`
  return db.select({ id: mediaFiles.id, size: mediaFiles.size }).from(mediaFiles).where(and(
    eq(mediaFiles.cached, true), present, settled, deletable,
    sql`${mediaFiles.addedAt} < ${new Date(Date.now() - timing.graceMs).toISOString()}::timestamptz`,
    sql`not ${pinnedFile(fileLinks, queued)}`,
    skipped.length > 0 ? sql`${mediaFiles.id} <> all(${uuidArray(skipped)})` : undefined,
  )).orderBy(lastUsed, mediaFiles.id).limit(RANK_BATCH)
}

type Deleted = { size: number; recordingId: string | null; albumId: string | null }

/**
 * Deletes one cached file in a managed root from disk and the database. With `unpinned`,
 * only while nothing pins it (checked now, with the queues read again); with
 * `recordingId`, only while the file is still linked to that recording and its match was
 * not fixed by hand (a delivery judged not to be what was asked for). Null when the file is
 * gone, no longer cache, pinned or changed. Throws when the file cannot be deleted from
 * disk; its row is kept.
 */
export async function deleteCachedFile(fileId: string, check: { unpinned?: boolean; recordingId?: string | null } = {}): Promise<Deleted | null> {
  if (check.unpinned) {
    const [links] = await db.select({ recordingId: mediaFiles.recordingId, albumId: mediaFiles.albumId }).from(mediaFiles).where(eq(mediaFiles.id, fileId))
    if (!links || await isPinned(links)) return null
  }
  const removed = await deleteLibraryFile(fileId, {
    where: and(
      eq(mediaFiles.cached, true),
      check.recordingId === undefined ? undefined : and(
        eq(mediaFiles.matchLocked, false),
        check.recordingId === null ? isNull(mediaFiles.recordingId) : eq(mediaFiles.recordingId, check.recordingId),
      ),
    ),
  })
  if (!removed) return null
  usageCache = undefined
  return { size: removed.size, recordingId: removed.recordingId, albumId: removed.albumId }
}

/**
 * Cached files are in no library but those of users who saved their album or recording, so
 * only those users' songs lists move; everyone else sees the rows turn on demand or gray.
 */
async function announceDeleted(recordingIds: string[], albumIds: string[]) {
  await announceAvailability(recordingIds)
  for (const user of await saversOf(albumIds, recordingIds)) await invalidate({ user }, [queryKeys.libraryTracks()])
  await invalidate('admins', [queryKeys.admin()])
}

/**
 * Deletes the delivered files of an ended job's import that are not a recording the job
 * asked for (after following merges): wrong songs, extras, files nothing identified. A
 * delivery is never left for review, and a file the provider sent under the identity of a
 * track the server already has never stays to play as that track.
 *
 * An extra that is the only file of its recording may already be serving: while the import
 * ran it made the track playable, so it may be queued, liked or saved, another job may have
 * counted it as its own delivery (`work.copies`), or another job may be fetching it. Such a
 * file is kept, as cache like any other, and eviction decides about it later.
 *
 * Only provider-delivered files of the job's own import in a managed root are touched;
 * library files the import kept instead of duplicates are not, and neither are files an
 * admin fixed the match of. Does nothing while the import is still running. Returns how
 * many files it deleted.
 */
export async function discardUnrequested(job: { id?: string; recordingIds: string[]; importId: string | null }): Promise<number> {
  if (!job.importId) return 0
  const [done] = await db.select({ status: imports.status, rootId: imports.targetRootId }).from(imports).where(eq(imports.id, job.importId))
  if (!done || (done.status !== 'completed' && done.status !== 'failed')) return 0
  const folder = `${incomingFolder(job.importId)}/`
  // A range on the byte-ordered path index (`media_files_scan_order`), not a scan.
  const inFolder = done.rootId ? and(eq(mediaFiles.rootId, done.rootId),
    sql`${mediaFiles.relPath} collate "C" >= ${folder} and ${mediaFiles.relPath} collate "C" < ${`${folder.slice(0, -1)}0`}`) : undefined
  const files = await db.select({ id: mediaFiles.id, recordingId: mediaFiles.recordingId }).from(mediaFiles).where(and(
    eq(mediaFiles.cached, true), present, eq(mediaFiles.matchLocked, false),
    or(eq(mediaFiles.importId, job.importId), inFolder),
  ))
  if (files.length === 0) return 0
  const resolved = await resolveMerged('recordings', [...job.recordingIds, ...files.flatMap((file) => file.recordingId ? [file.recordingId] : [])])
  const target = (id: string) => resolved.get(id) ?? id
  const wanted = new Set(job.recordingIds.map(target))
  const unwanted = files.filter((file) => !file.recordingId || !wanted.has(target(file.recordingId)))
  const recordings: string[] = []
  const albums: string[] = []
  let deleted = 0
  for (const file of unwanted) {
    if (file.recordingId && await stillServing(file.id, file.recordingId, job.id)) continue
    const gone = await deleteCachedFile(file.id, { recordingId: file.recordingId }).catch((error: unknown) => {
      report(error)
      return null
    })
    if (!gone) continue
    deleted += 1
    if (gone.recordingId) recordings.push(gone.recordingId)
    if (gone.albumId) albums.push(gone.albumId)
  }
  if (deleted > 0) await announceDeleted(recordings, albums)
  return deleted
}

/** Jobs that ended this recently still count as wanting what they fetched. */
const RECENT_JOB_MS = 2 * 60 * 60_000

/**
 * Whether an unrequested delivered file is the only file of its recording and something
 * already relies on it (see `discardUnrequested`). A recording the server has other files
 * for does not need this one.
 */
async function stillServing(fileId: string, recordingId: string, jobId: string | undefined): Promise<boolean> {
  const [other] = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(eq(mediaFiles.recordingId, recordingId), present, sql`${mediaFiles.id} <> ${fileId}`)).limit(1)
  if (other) return false
  const [file] = await db.select({ albumId: mediaFiles.albumId }).from(mediaFiles).where(eq(mediaFiles.id, fileId))
  if (await isPinned({ recordingId, albumId: file?.albumId ?? null })) return true
  const since = new Date(Date.now() - RECENT_JOB_MS).toISOString()
  const [relied] = await db.execute<{ relied: boolean }>(sql`select (
    exists (
      select 1 from acquisition_jobs j
      where j.recording_ids @> array[${recordingId}::uuid] ${jobId ? sql`and j.id <> ${jobId}` : sql``}
        and (j.completed_at is null or j.completed_at > ${since}::timestamptz))
    or exists (
      select 1 from imports i
      where i.kind = 'acquisition' and i.updated_at > ${since}::timestamptz and coalesce(i.work->'copies', '[]'::jsonb) ? ${fileId})
  ) as relied`)
  return Boolean(relied?.relied)
}
