/**
 * `imports.process`: takes a committed import from staging into the library.
 *
 *   extracting   zip archives in staging are checked and extracted beside themselves
 *   moving       staged files move to `<root>/_Incoming/<importId>/`; scans leave that
 *                folder alone until this step is done
 *   identifying  a scan of the folder hands the files to the library pipeline (probe,
 *                ingest, analyze, match); this step watches the rows until every file is
 *                read, hashed and matched, removing duplicates as their hashes arrive, or
 *                until the time limit leaves the rest for review
 *   filing       an organize batch moves the identified albums to their place in the root
 *
 * Each step is idempotent and records its outcome before the import moves to the next, so
 * after a crash the job (retried by pg-boss, or re-queued by `imports.sweep`) runs the
 * current step again and carries on.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { INCOMING_FOLDER, queryKeys, type ImportStep } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db, getSql } from '../../database/client.js'
import { imports, libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { AppError } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { lockCatalog, removeOrphans } from '../library/cleanup.js'
import { applyBatch } from '../organize/apply.js'
import { errorCode, moveFile, realFileOps, type FileOps } from '../organize/files.js'
import { planOrganize } from '../organize/plan.js'
import { refreshWants } from '../userdata/wants.js'
import { extractArchive, inspectArchive } from './archive.js'
import { fileKind, numbered } from './paths.js'
import { announceImport, incomingFolder, releaseStaging, type ImportRow, type ImportWork } from './service.js'
import { TEMP_PREFIX, treeFiles } from './staging.js'

export type ImportProcessJob = { importId: string }

export type ProcessOptions = {
  /** How long identification may run before what is still pending is left for review. */
  identifyTimeoutMs?: number
  /** How often identification looks at the database. */
  pollMs?: number
  /** How long filing waits for another organize batch in the root to finish. */
  organizeWaitMs?: number
  /** File operations for the move into the root. Tests force `EXDEV` with them. */
  ops?: FileOps
}

const defaults = { identifyTimeoutMs: 60 * 60_000, pollMs: 1000, organizeWaitMs: 30 * 60_000 }
/** Archives with more entries than this are refused outright. */
const maxArchiveEntries = 10_000

/** An import that cannot go on. It fails without being retried. */
export class ImportFailure extends Error {}

type Root = typeof libraryRoots.$inferSelect & { realPath: string }
type Stats = Record<string, number>

const next: Record<ImportStep, ImportStep | null> = { extracting: 'moving', moving: 'identifying', identifying: 'filing', filing: null }
const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const exists = (file: string) => lstat(file).then(() => true, () => false)

async function load(importId: string): Promise<ImportRow | undefined> {
  const [row] = await db.select().from(imports).where(eq(imports.id, importId))
  return row
}

/**
 * Runs every remaining step of a processing import. Another run of the same import in any
 * process holds a lock and makes this one return at once.
 */
export async function processImport(importId: string, options: ProcessOptions = {}): Promise<void> {
  const connection = await getSql().reserve()
  const key = `squirmy.import:${importId}`
  try {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked`
    if (!row?.locked) return
    try {
      while ((await runStep(importId, options))?.status === 'processing');
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${key}))`
    }
  } finally {
    connection.release()
  }
}

/**
 * Runs the import's current step and moves it on to the next (or to `completed`). Returns
 * the row afterwards, or null when the import is not processing. Exported so tests can stop
 * between steps, which is what a crash looks like to the next run.
 */
export async function runStep(importId: string, options: ProcessOptions = {}): Promise<ImportRow | null> {
  const row = await load(importId)
  if (row?.status !== 'processing' || !row.step) return null
  const root = await targetRoot(row)
  const settings = { ...defaults, ...options }
  const stats: Stats = { ...row.stats }
  const work: ImportWork = { ...(row.work as ImportWork | null) }
  switch (row.step) {
    case 'extracting':
      await extract(row, stats, work)
      break
    case 'moving':
      await moveIn(row, root, stats, settings.ops ?? realFileOps)
      break
    case 'identifying':
      await identify(row, root, stats, work, settings)
      break
    case 'filing':
      await file(row, root, stats, work, settings)
      break
  }
  return advance(row, stats, work)
}

/** Records the step's outcome and starts the next one. Only the run that finished the step moves the import on. */
async function advance(row: ImportRow, stats: Stats, work: ImportWork): Promise<ImportRow | null> {
  const step = next[row.step!]
  const now = new Date()
  const [updated] = await db.update(imports).set({
    stats, work, updatedAt: now,
    ...(step ? { step, stepStartedAt: now } : { status: 'completed' as const, step: null, completedAt: now }),
  }).where(and(eq(imports.id, row.id), eq(imports.status, 'processing'), eq(imports.step, row.step!))).returning()
  if (!updated) return null
  await announceImport(updated)
  if (!step) await invalidate('all', [queryKeys.library(), queryKeys.home()])
  return updated
}

/** Fails a processing import, keeping whatever already reached the library root. */
export async function markFailed(importId: string, reason: string) {
  const [row] = await db.update(imports).set({ status: 'failed', step: null, error: reason, updatedAt: new Date(), completedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.status, 'processing'))).returning()
  if (!row) return
  await releaseStaging(row)
  await announceImport(row)
}

async function targetRoot(row: ImportRow): Promise<Root> {
  const [root] = row.targetRootId ? await db.select().from(libraryRoots).where(eq(libraryRoots.id, row.targetRootId)) : []
  if (!root || root.mode !== 'managed' || !root.enabled) throw new ImportFailure('The library root this import was going to is no longer an enabled managed root')
  const realPath = await realpath(root.path).catch(() => null)
  if (!realPath) throw new Error(`The library root ${root.path} is not available`)
  return { ...root, realPath }
}

async function saveWork(importId: string, work: ImportWork) {
  await db.update(imports).set({ work, updatedAt: new Date() }).where(eq(imports.id, importId))
}

// ---------------------------------------------------------------------------
// extracting
// ---------------------------------------------------------------------------

/**
 * Extracts each staged archive into a folder beside it and deletes the archive. Where an
 * archive goes is recorded before anything is written, and it is extracted into a
 * temporary folder renamed into place at the end, so a crash leaves either nothing (the
 * archive is extracted again) or the finished folder (only the archive is left to delete).
 */
async function extract(row: ImportRow, stats: Stats, work: ImportWork) {
  const { importMaxFileBytes, importMaxBytes } = await getServerSettings()
  const staged = []
  for await (const entry of treeFiles(row.stagingPath)) staged.push(entry)
  const archives = (work.archives ??= {})
  let budget = importMaxBytes - staged.filter((entry) => fileKind(entry.relPath) !== 'archive').reduce((sum, entry) => sum + entry.size, 0)

  for (const archive of staged.filter((entry) => fileKind(entry.relPath) === 'archive')) {
    const record = archives[archive.relPath] ?? {}
    const parent = path.posix.dirname(archive.relPath) === '.' ? '' : path.posix.dirname(archive.relPath)
    if (!record.done && !(record.target && await exists(path.join(row.stagingPath, record.target)))) {
      const plan = await inspectArchive(archive.absolute, { maxEntries: maxArchiveEntries, maxEntryBytes: importMaxFileBytes, maxTotalBytes: budget })
      if (!plan.ok) {
        archives[archive.relPath] = { rejected: plan.reason, done: true }
      } else {
        if (!record.target) {
          const taken = new Set(Object.values(archives).map((other) => other.target))
          for (let n = 1; ; n++) {
            const candidate = parent ? `${parent}/${numbered(plan.folder, n)}` : numbered(plan.folder, n)
            if (!taken.has(candidate) && !await exists(path.join(row.stagingPath, candidate))) {
              record.target = candidate
              break
            }
          }
          archives[archive.relPath] = record
          await saveWork(row.id, work)
        }
        const temp = path.join(row.stagingPath, parent, `${TEMP_PREFIX}extract-${shortHash(archive.relPath)}`)
        await rm(temp, { recursive: true, force: true })
        const result = await extractArchive(archive.absolute, plan, temp)
        if (result.ok) {
          archives[archive.relPath] = { target: record.target, extracted: result.extracted, skipped: plan.skipped + result.duplicates }
          await saveWork(row.id, work)
          await rename(temp, path.join(row.stagingPath, record.target!))
          budget -= plan.bytes
        } else {
          await rm(temp, { recursive: true, force: true })
          archives[archive.relPath] = { rejected: result.reason, done: true }
        }
      }
    }
    archives[archive.relPath] = { ...archives[archive.relPath], done: true }
    await saveWork(row.id, work)
    await rm(archive.absolute, { force: true })
  }

  const records = Object.values(archives)
  stats.filesExtracted = records.reduce((sum, record) => sum + (record.extracted ?? 0), 0)
  stats.archivesRejected = records.filter((record) => record.rejected).length
  stats.filesRejected = (work.rejectedOnReceipt ?? 0) + records.reduce((sum, record) => sum + (record.skipped ?? 0), 0)
}

// ---------------------------------------------------------------------------
// moving
// ---------------------------------------------------------------------------

/** Creates a directory, refusing one that is a symbolic link or not a directory. */
async function realDirectory(directory: string) {
  await mkdir(directory, { recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ImportFailure(`${directory} is not a folder the server can import into`)
}

/**
 * Moves every staged file to `_Incoming/<importId>/` in the root with organize's mover:
 * a rename within one file system, else copy, verify and delete. Run again after a crash,
 * it finishes or redoes each interrupted move. Counts the audio files that arrived and
 * removes the staging folder.
 */
async function moveIn(row: ImportRow, root: Root, stats: Stats, ops: FileOps) {
  const incoming = path.join(root.realPath, INCOMING_FOLDER)
  const destination = path.join(incoming, row.id)
  await realDirectory(incoming)
  await realDirectory(destination)
  for await (const staged of treeFiles(row.stagingPath)) {
    const to = path.join(destination, staged.relPath)
    await moveFile(staged.absolute, to, {
      temp: path.join(path.dirname(to), `${TEMP_PREFIX}move-${shortHash(staged.relPath)}.tmp`),
      ops,
      ensureDirectory: async (directory) => {
        await mkdir(directory, { recursive: true })
      },
      // Nothing but this import writes into its folder, so a file already there is the one that moved.
      isMovedFile: async (_to, info) => info.isFile(),
    })
  }
  let audio = 0
  for await (const arrived of treeFiles(destination)) if (fileKind(arrived.relPath) === 'audio') audio += 1
  stats.audioFiles = audio
  await rm(row.stagingPath, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// identifying
// ---------------------------------------------------------------------------

/** Rows of the import's files, wherever they are now. */
const ofImport = (row: ImportRow) => and(eq(mediaFiles.importId, row.id), sql`${mediaFiles.missingSince} is null`)

/**
 * Waits for the library pipeline to finish with the import's files, judging only by
 * database state: every file has its tags read and its audio hashed (or failed), is linked
 * to the catalog, and is matched one way or another. Along the way it marks new rows with
 * the import, removes duplicates, and queues a scan of the folder whenever rows are
 * missing and no scan of the root is queued. The time limit counts from the step's start,
 * so a resumed run does not start the clock again.
 */
async function identify(row: ImportRow, root: Root, stats: Stats, work: ImportWork, options: typeof defaults) {
  const deadline = (row.stepStartedAt ?? new Date()).getTime() + options.identifyTimeoutMs
  const folder = incomingFolder(row.id)
  for (;;) {
    await db.transaction(async (tx) => {
      // Ingest and matching update these rows too, under the catalog lock.
      await lockCatalog(tx)
      await tx.update(mediaFiles).set({ source: row.source, importId: row.id, updatedAt: new Date() }).where(and(
        eq(mediaFiles.rootId, root.id),
        sql`starts_with(${mediaFiles.relPath}, ${`${folder}/`})`,
        sql`${mediaFiles.importId} is distinct from ${row.id}`,
      ))
    })
    const removed = await removeDuplicates(row, root)
    if (removed > 0) {
      stats.duplicatesSkipped = (stats.duplicatesSkipped ?? 0) + removed
      await db.update(imports).set({ stats, updatedAt: new Date() }).where(eq(imports.id, row.id))
    }

    const { musicBrainzEnabled } = await getServerSettings()
    const [state] = await db.select({
      rows: sql<number>`count(*)::int`,
      pending: sql<number>`(count(*) filter (where ${mediaFiles.probeError} is null and (
        ${mediaFiles.probeStage} < 2 or ${mediaFiles.recordingId} is null
        or (${mediaFiles.matchStatus} = 'pending' and ${musicBrainzEnabled})
      )))::int`,
    }).from(mediaFiles).where(ofImport(row))
    const expected = (stats.audioFiles ?? 0) - (stats.duplicatesSkipped ?? 0)
    if (state!.rows >= expected && state!.pending === 0) return
    if (state!.rows < expected && !await scanQueued(root.id)) {
      // Owned by the library module; one scan per root at a time, so this may need a retry.
      await enqueue('library.scan', { rootId: root.id, paths: [folder] }, { singletonKey: root.id })
    }
    if (Date.now() >= deadline) {
      work.timedOut = true
      return
    }
    await sleep(options.pollMs)
  }
}

async function scanQueued(rootId: string): Promise<boolean> {
  const [row] = await db.execute<{ queued: boolean }>(sql`
    select exists (select 1 from pgboss.job where name = 'library.scan' and singleton_key = ${rootId} and state in ('created', 'retry', 'active')) as queued`)
  return Boolean(row?.queued)
}

/**
 * Deletes the import's files whose audio the library already has: another present file
 * with the same hash that is not part of an import still in progress, or an earlier copy
 * within this import. Two imports of one album at once keep the older file. Returns how
 * many were removed; their groups are queued for ingest again.
 */
async function removeDuplicates(row: ImportRow, root: Root): Promise<number> {
  // Rows first, under the catalog lock: analysis takes a row whose file has vanished for a
  // moved file, so a file may only go once no row points at it. A crash before the files
  // are deleted leaves files a later scan brings back, to be found again.
  const deleted = await db.transaction(async (tx) => {
    await lockCatalog(tx)
    const gone = await tx.delete(mediaFiles).where(and(
      ofImport(row),
      eq(mediaFiles.rootId, root.id),
      sql`${mediaFiles.audioHash} is not null`,
      sql`exists (
        select 1 from media_files other
        where other.audio_hash = ${mediaFiles.audioHash} and other.id <> ${mediaFiles.id} and other.missing_since is null
          and (other.id < ${mediaFiles.id} or other.import_id is null
            or not exists (select 1 from imports i where i.id = other.import_id and i.status = 'processing'))
      )`,
    )).returning({ relPath: mediaFiles.relPath, groupKey: mediaFiles.groupKey, albumId: mediaFiles.albumId, releaseId: mediaFiles.releaseId, recordingId: mediaFiles.recordingId })
    if (gone.length > 0) {
      await removeOrphans(tx, { albumIds: gone.map((file) => file.albumId), releaseIds: gone.map((file) => file.releaseId), recordingIds: gone.map((file) => file.recordingId) })
    }
    return gone
  })
  for (const file of deleted) await rm(path.join(root.realPath, file.relPath), { force: true })
  // Owned by the library module: the groups lost files.
  for (const groupKey of new Set(deleted.map((file) => file.groupKey))) {
    if (groupKey) await enqueue('library.ingest', { rootId: root.id, groupKey }, { singletonKey: groupKey })
  }
  return deleted.length
}

// ---------------------------------------------------------------------------
// filing
// ---------------------------------------------------------------------------

/**
 * Files the albums the matcher identified with confidence: plans one organize batch
 * restricted to them (remembered, so a rerun applies the same batch) and applies it. What
 * was not identified stays in `_Incoming/<importId>/`; the folder is removed once no audio
 * is left in it. Then the counts are taken and wants are refreshed.
 */
async function file(row: ImportRow, root: Root, stats: Stats, work: ImportWork, options: typeof defaults) {
  const folder = incomingFolder(row.id)
  if (!work.batchId) {
    const albums = await db.selectDistinct({ albumId: mediaFiles.albumId }).from(mediaFiles).where(and(
      ofImport(row), eq(mediaFiles.matchStatus, 'matched'), sql`${mediaFiles.albumId} is not null`,
      sql`starts_with(${mediaFiles.relPath}, ${`${folder}/`})`,
    ))
    if (albums.length > 0) {
      work.batchId = await planOrganize({ rootId: root.id, albumIds: albums.map((album) => album.albumId!), includeIncoming: true, userId: row.userId })
      await saveWork(row.id, work)
    }
  }
  if (work.batchId) await applyWhenFree(work.batchId, options)

  const destination = path.join(root.realPath, INCOMING_FOLDER, row.id)
  // Counted on disk: when identification ran out of time, some files may have no row yet.
  let audioLeft = 0
  for await (const left of treeFiles(destination)) if (fileKind(left.relPath) === 'audio') audioLeft += 1
  if (audioLeft === 0) {
    await rm(destination, { recursive: true, force: true })
    await rmdir(path.join(root.realPath, INCOMING_FOLDER)).catch(() => {})
  }

  const [counts] = await db.select({
    albumsIdentified: sql<number>`(count(distinct ${mediaFiles.albumId}) filter (where ${mediaFiles.matchStatus} = 'matched'))::int`,
    filesFiled: sql<number>`(count(*) filter (where not starts_with(${mediaFiles.relPath}, ${`${folder}/`})))::int`,
    albumsFiled: sql<number>`(count(distinct ${mediaFiles.albumId}) filter (where not starts_with(${mediaFiles.relPath}, ${`${folder}/`})))::int`,
    unreadable: sql<number>`(count(*) filter (where ${mediaFiles.probeError} is not null))::int`,
  }).from(mediaFiles).where(ofImport(row))
  Object.assign(stats, counts, { filesLeftForReview: audioLeft })
  await refreshWants()
}

/** Applies a batch, waiting while another batch holds the root. Gives up quietly after `organizeWaitMs`. */
async function applyWhenFree(batchId: string, options: typeof defaults) {
  const deadline = Date.now() + options.organizeWaitMs
  for (;;) {
    try {
      await applyBatch(batchId)
      return
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'organize_busy')) throw error
      if (Date.now() >= deadline) return
    }
    await sleep(options.pollMs)
  }
}

/** Describes a failure for the import's `error`. */
export function failureMessage(error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOSPC') return 'The disk is full'
  if (code === 'EACCES' || code === 'EPERM') return 'The server does not have permission to write there'
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}
