import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { FETCHED_FOLDER, INCOMING_FOLDER, queryKeys, type ScanStats } from '@squirmy/contracts'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { imports, libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueueMany } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { invalidate, publish } from '../../realtime/index.js'
import { lockCatalog, removeOrphans } from './cleanup.js'
import { ANALYZE_PRIORITY } from './probe.js'
import { invalidateSoon, publishProbeProgress, warn } from './progress.js'
import { containerFromExtension } from './tags.js'
import { compareBytes, isSkippedPath, walk, type WalkEntry } from './walk.js'

/** Without `paths` the whole root is scanned; with them, only those root-relative files and folders. */
export type ScanJob = { rootId: string; paths?: string[] }

const batchSize = 500
const pageSize = 1000
/** `media_files.source` of a file the scanner finds under `_Fetched/`: a delivery of unknown origin. */
export const FETCHED_SOURCE = 'provider:unknown'

type Row = { id: string; relPath: string; size: number; mtime: Date; missingSince: Date | null }

/** Rows under `scope` (a root-relative path, '' for all) in byte order of their path, a page at a time. */
async function* rowsUnder(rootId: string, scope: string): AsyncGenerator<Row> {
  const byteOrder = sql`${mediaFiles.relPath} collate "C"`
  // The range lets the index bound the read; the second test drops "scope.flac" and "scope 2/".
  const inScope = scope
    ? and(sql`${byteOrder} >= ${scope}`, sql`${byteOrder} < ${`${scope}0`}`, or(eq(mediaFiles.relPath, scope), sql`starts_with(${mediaFiles.relPath}, ${`${scope}/`})`))
    : undefined
  let after: string | undefined
  for (;;) {
    const page = await db.select({ id: mediaFiles.id, relPath: mediaFiles.relPath, size: mediaFiles.size, mtime: mediaFiles.mtime, missingSince: mediaFiles.missingSince })
      .from(mediaFiles)
      .where(and(eq(mediaFiles.rootId, rootId), inScope, after === undefined ? undefined : sql`${byteOrder} > ${after}`))
      .orderBy(byteOrder)
      .limit(pageSize)
    yield* page
    if (page.length < pageSize) return
    after = page[page.length - 1]!.relPath
  }
}

/** Collects the scan's writes and applies them in bulk. */
class ScanWriter {
  readonly stats: ScanStats = { filesSeen: 0, filesAdded: 0, filesChanged: 0, filesMissing: 0, errors: 0 }
  filesReturned = 0
  private added: WalkEntry[] = []
  private changed: { id: string; size: number; mtime: string }[] = []
  private returned: string[] = []
  private missing: string[] = []

  /** `managed`: only a managed root has a `_Fetched/` folder that Organize filed deliveries in. */
  constructor(private readonly rootId: string, private readonly managed: boolean) {}

  async add(entry: WalkEntry) {
    this.added.push(entry)
    await this.maybeFlush()
  }

  async seen(row: Row, entry: WalkEntry) {
    if (row.size !== entry.size || row.mtime.getTime() !== entry.mtime.getTime()) {
      this.changed.push({ id: row.id, size: entry.size, mtime: entry.mtime.toISOString() })
      if (row.missingSince) this.filesReturned += 1
    } else if (row.missingSince) {
      this.returned.push(row.id)
    }
    await this.maybeFlush()
  }

  async unseen(row: Row) {
    if (row.missingSince) return
    this.missing.push(row.id)
    await this.maybeFlush()
  }

  private async maybeFlush() {
    if (Math.max(this.added.length, this.changed.length, this.returned.length, this.missing.length) >= batchSize) await this.flush()
  }

  async flush() {
    const probe: string[] = []
    if (this.added.length > 0) {
      const inserted = await db.insert(mediaFiles).values(this.added.map((entry) => ({
        id: newId(),
        rootId: this.rootId,
        relPath: entry.relPath,
        size: entry.size,
        mtime: entry.mtime,
        container: containerFromExtension(path.extname(entry.relPath).slice(1)),
        codec: 'unknown',
        // Only provider deliveries are filed under a managed root's `_Fetched/`. A file found
        // there with no row (the database was restored without it) stays cache rather than
        // joining every user's library as if someone had brought it. A read-only root is
        // never cache: whatever it holds, the server must not delete.
        ...(this.managed && entry.relPath.startsWith(`${FETCHED_FOLDER}/`) ? { source: FETCHED_SOURCE } : {}),
      }))).onConflictDoNothing({ target: [mediaFiles.rootId, mediaFiles.relPath] }).returning({ id: mediaFiles.id })
      this.stats.filesAdded += inserted.length
      probe.push(...inserted.map((row) => row.id))
    }
    if (this.changed.length > 0) {
      await db.execute(sql`
        update media_files f set size = v.size, mtime = v.mtime, probe_stage = 0, probe_error = null, missing_since = null, updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(this.changed)}::jsonb) as v(id uuid, size bigint, mtime timestamptz)
        where f.id = v.id`)
      this.stats.filesChanged += this.changed.length
      probe.push(...this.changed.map((row) => row.id))
    }
    if (this.returned.length > 0) {
      await db.update(mediaFiles).set({ missingSince: null, updatedAt: new Date() }).where(inArray(mediaFiles.id, this.returned))
      this.filesReturned += this.returned.length
    }
    if (this.missing.length > 0) {
      await db.update(mediaFiles).set({ missingSince: new Date(), updatedAt: new Date() }).where(and(inArray(mediaFiles.id, this.missing), isNull(mediaFiles.missingSince)))
      this.stats.filesMissing += this.missing.length
    }
    await enqueueMany('library.probe', probe.map((fileId) => ({ data: { fileId }, singletonKey: fileId })))
    this.added = []
    this.changed = []
    this.returned = []
    this.missing = []
  }
}

/**
 * A test for paths inside `_Incoming/<importId>` folders an import is still extracting or
 * moving files into. The scan leaves them alone, neither adding their files nor marking
 * them missing, and the import scans the folder itself once it is done.
 */
async function heldByImports(rootId: string): Promise<(relPath: string) => boolean> {
  const held = (await db.select({ id: imports.id }).from(imports).where(and(
    eq(imports.targetRootId, rootId), eq(imports.status, 'processing'), inArray(imports.step, ['extracting', 'moving']),
  ))).map((row) => `${INCOMING_FOLDER}/${row.id}`)
  return (relPath) => held.some((folder) => relPath === folder || relPath.startsWith(`${folder}/`))
}

/** Root-relative scopes with descendants of other scopes removed. '' covers everything. */
function normalizeScopes(paths: readonly string[]): string[] {
  const cleaned = [...new Set(paths.map((value) => value.replace(/^\/+|\/+$/g, '')))]
    .filter((value) => !value.split('/').includes('..') && (value === '' || !isSkippedPath(value)))
    .sort(compareBytes)
  const scopes: string[] = []
  for (const scope of cleaned) {
    if (scopes.some((parent) => parent === '' || scope === parent || scope.startsWith(`${parent}/`))) continue
    scopes.push(scope)
  }
  return scopes
}

/**
 * Walks a root (or part of it) and reconciles `media_files` with what is on disk, comparing
 * `(rel_path, size, mtime)`: new files are inserted at `probe_stage` 0, changed ones are
 * reset for a new probe, files the walk did not see get `missing_since`, and files that
 * came back lose it. Probes are queued in bulk as it goes.
 *
 * The directory walk and the rows are both read in byte order of the path and merged like
 * two sorted lists, so a scan of any size holds one page of rows and one folder listing
 * per level in memory, and issues a few queries per thousand files.
 *
 * A root that cannot be read (an unmounted drive) is skipped rather than marking every
 * file missing. A full scan also re-queues files whose probe or analysis never finished.
 */
export async function scanRoot({ rootId, paths }: ScanJob): Promise<ScanStats | null> {
  const [root] = await db.select().from(libraryRoots).where(eq(libraryRoots.id, rootId))
  if (!root?.enabled) return null
  const rootPath = await realpath(root.path).catch(() => null)
  if (!rootPath || !(await stat(rootPath)).isDirectory()) {
    warn(`Skipping the scan of ${root.path}: the folder is not available`)
    return null
  }
  const full = paths === undefined
  const started = Date.now()
  if (full) await db.update(libraryRoots).set({ lastScanStartedAt: new Date(started) }).where(eq(libraryRoots.id, rootId))
  await invalidate('admins', [queryKeys.adminRoots()])

  const writer = new ScanWriter(rootId, root.mode === 'managed')
  const held = await heldByImports(rootId)
  let lastProgress = 0
  const onError = (relPath: string, error: unknown) => {
    writer.stats.errors += 1
    warn(`Cannot read ${path.join(rootPath, relPath)}: ${(error as Error).message}`)
  }
  for (const scope of full ? [''] : normalizeScopes(paths)) {
    const rows = rowsUnder(rootId, scope)
    let row = (await rows.next()).value as Row | undefined
    for await (const entry of walk(scope, { root: rootPath, onError })) {
      if (held(entry.relPath)) continue
      writer.stats.filesSeen += 1
      while (row && compareBytes(row.relPath, entry.relPath) < 0) {
        if (!held(row.relPath)) await writer.unseen(row)
        row = (await rows.next()).value as Row | undefined
      }
      if (row && row.relPath === entry.relPath) {
        await writer.seen(row, entry)
        row = (await rows.next()).value as Row | undefined
      } else {
        await writer.add(entry)
      }
      if (Date.now() - lastProgress > 1000) {
        lastProgress = Date.now()
        await publish('admins', { type: 'scan.progress', rootId, phase: 'discovering', processed: writer.stats.filesSeen, total: writer.stats.filesSeen })
      }
    }
    while (row) {
      if (!held(row.relPath)) await writer.unseen(row)
      row = (await rows.next()).value as Row | undefined
    }
  }
  await writer.flush()
  if (full) await requeueUnfinished(rootId)

  const { stats } = writer
  if (full) await db.update(libraryRoots).set({ lastScanFinishedAt: new Date(), lastScanStats: stats, updatedAt: new Date() }).where(eq(libraryRoots.id, rootId))
  // Missing and returning files change what is playable.
  if (stats.filesMissing > 0 || writer.filesReturned > 0) invalidateSoon([queryKeys.library(), queryKeys.home()])
  await invalidate('admins', [queryKeys.adminRoots()])
  await publishProbeProgress(rootId)
  return stats
}

/** Queues probes and analyses that were lost (a crash, a restart) for present files. */
async function requeueUnfinished(rootId: string) {
  for (const [stage, queue, priority] of [[0, 'library.probe', 0], [1, 'library.analyze', ANALYZE_PRIORITY]] as const) {
    let after: string | undefined
    for (;;) {
      const page = await db.select({ id: mediaFiles.id }).from(mediaFiles)
        .where(and(
          eq(mediaFiles.rootId, rootId), eq(mediaFiles.probeStage, stage), isNull(mediaFiles.probeError), isNull(mediaFiles.missingSince),
          after === undefined ? undefined : gt(mediaFiles.id, after),
        ))
        .orderBy(asc(mediaFiles.id))
        .limit(pageSize)
      await enqueueMany(queue, page.map((row) => ({ data: { fileId: row.id }, singletonKey: row.id, priority })))
      if (page.length < pageSize) break
      after = page[page.length - 1]!.id
    }
  }
}

/** Deletes files missing for longer than the grace period, then the catalog rows they leave unused. */
export async function purgeMissing(): Promise<number> {
  const { missingFileGraceDays } = await getServerSettings()
  const cutoff = new Date(Date.now() - missingFileGraceDays * 24 * 60 * 60 * 1000)
  const purged = await db.transaction(async (tx) => {
    await lockCatalog(tx)
    const deleted = await tx.delete(mediaFiles).where(and(isNotNull(mediaFiles.missingSince), lte(mediaFiles.missingSince, cutoff))).returning({ id: mediaFiles.id })
    if (deleted.length > 0) await removeOrphans(tx)
    return deleted.length
  })
  if (purged > 0) invalidateSoon([queryKeys.library(), queryKeys.home()])
  return purged
}
