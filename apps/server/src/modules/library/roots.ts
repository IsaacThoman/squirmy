import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryRoot, LibraryRootMode, ScanStats } from '@squirmy/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, type Executor } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { enqueue, findJob, replaceQueuedData, takeQueued } from '../../jobs/index.js'
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { validateTemplate } from '../organize/template.js'
import { warn } from './progress.js'
import { scanRoot, type ScanJob } from './scan.js'

type RootRow = typeof libraryRoots.$inferSelect

/** Resolves a requested root to its real path, failing unless it is a readable directory. */
export async function resolveRootPath(requested: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw badRequest('Give an absolute path', 'relative_path')
  try {
    const resolved = await realpath(requested)
    if (!(await stat(resolved)).isDirectory()) throw badRequest('That path is not a folder', 'not_a_directory')
    return resolved
  } catch (error) {
    if (error instanceof AppError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw badRequest('No such folder', 'path_not_found')
    if (code === 'EACCES' || code === 'EPERM') throw forbidden('The server cannot read that folder', 'permission_denied')
    throw error
  }
}

/**
 * Refuses a template organize could not use, as a validation issue on `template` so a form
 * can show the message next to the field. Null (the default) is always fine.
 */
export function checkTemplate(template: string | null | undefined) {
  const message = template == null ? null : validateTemplate(template)
  if (message) throw badRequest(message, 'invalid_request', [{ code: 'custom', path: ['template'], message }])
}

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Inserts a root unless it repeats or overlaps an existing one: a file must belong to
 * exactly one root. Holds a lock so two requests cannot add overlapping roots at once.
 */
export async function insertRoot(input: { name: string; path: string; mode: LibraryRootMode; watch: boolean; template?: string | null }): Promise<RootRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:library-roots'))`)
    for (const existing of await tx.select({ id: libraryRoots.id, path: libraryRoots.path }).from(libraryRoots)) {
      // The id lets a client that added the folder before treat it as already added.
      if (existing.path === input.path) throw new AppError(409, 'duplicate_root', 'That folder is already a library root', { rootId: existing.id })
      if (inside(existing.path, input.path) || inside(input.path, existing.path)) {
        throw conflict(`That folder overlaps the library root ${existing.path}`, 'nested_root')
      }
    }
    const [row] = await tx.insert(libraryRoots).values({ id: newId(), ...input }).returning()
    return row!
  })
}

/** Roots with their live file counts and whether a scan is queued or running. */
export async function listRoots(executor: Executor = db, id?: string): Promise<LibraryRoot[]> {
  const rows = await executor.select({
    root: libraryRoots,
    // Qualified by hand: inside a subquery Drizzle's bare "id" would mean the inner table's.
    fileCount: sql<number>`(select count(*) from media_files f where f.root_id = library_roots.id and f.missing_since is null)::int`,
    cachedFileCount: sql<number>`(select count(*) from media_files f where f.root_id = library_roots.id and f.missing_since is null and f.cached)::int`,
    scanning: sql<boolean>`exists (select 1 from pgboss.job j where j.name = 'library.scan' and j.singleton_key = library_roots.id::text and j.state in ('created', 'retry', 'active'))`,
  }).from(libraryRoots).where(id ? eq(libraryRoots.id, id) : undefined).orderBy(asc(libraryRoots.name), asc(libraryRoots.createdAt))
  return rows.map(({ root, fileCount, cachedFileCount, scanning }) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    mode: root.mode,
    enabled: root.enabled,
    watch: root.watch,
    template: root.template,
    scanning,
    fileCount,
    cachedFileCount,
    lastScanStartedAt: root.lastScanStartedAt?.toISOString() ?? null,
    lastScanFinishedAt: root.lastScanFinishedAt?.toISOString() ?? null,
    lastScanStats: (root.lastScanStats as ScanStats | null) ?? null,
  }))
}

/** How long a full scan waits behind a running partial one before it is retried on its own. */
const followUpDelaySeconds = 15 * 60

/**
 * Queues a full scan. Returns false when one is already queued or running.
 *
 * Every scan of a root holds the root's id as its key, so one runs at a time. When a
 * watcher or import scan of some paths holds it, the full scan is not dropped: a queued
 * one becomes a full scan, and a running one is followed by a `library.scan-after`, which
 * the running scan picks up as soon as it finishes (see `runScan`).
 */
export async function requestScan(rootId: string): Promise<boolean> {
  const outcome = await queueFullScan(rootId)
  if (outcome === 'behind') await enqueue('library.scan-after', { rootId }, { singletonKey: rootId, startAfter: followUpDelaySeconds })
  return outcome !== 'running'
}

type FullScanOutcome = 'queued' | 'running' | 'behind'

/** `behind`: a scan of only some paths is running, so a full one cannot be queued yet. */
async function queueFullScan(rootId: string): Promise<FullScanOutcome> {
  // Each pass loses at most one race against a job that started or finished meanwhile.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await enqueue('library.scan', { rootId }, { singletonKey: rootId })) return 'queued'
    const held = await findJob<ScanJob>('library.scan', rootId)
    if (!held) continue
    if (!held.data.paths) return 'running'
    if (held.state === 'active') return 'behind'
    // A full scan covers the paths the queued one was for.
    if (await replaceQueuedData<ScanJob>('library.scan', held.id, { rootId })) return 'queued'
  }
  return 'behind'
}

/** `library.scan`: scans, then runs a full scan that was asked for while this one ran. */
export async function runScan(data: ScanJob) {
  await scanRoot(data)
  if (data.paths && await takeQueued('library.scan-after', data.rootId)) await scanRoot({ rootId: data.rootId })
}

/**
 * `library.scan-after`: the fallback for a full scan the scan it waited for did not pick up
 * (that scan failed, or finished just before it was queued). Throws to be retried later
 * while a partial scan still holds the root.
 */
export async function runScanAfter({ rootId }: { rootId: string }) {
  if (await queueFullScan(rootId) === 'behind') throw new Error('A scan of some of this root\'s paths is still running')
}

/**
 * Adds each folder in SQUIRMY_MANAGED_LIBRARY_PATHS as a managed root and each in
 * SQUIRMY_LIBRARY_PATHS as a read-only one, unless a root already has that path, and
 * scans the new ones. A folder in both lists is managed. An existing root keeps its mode.
 * Folders that do not exist or overlap a root are reported and skipped.
 */
export async function addConfiguredRoots() {
  const config = getConfig()
  const list = (value: string | undefined) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const configured = [
    ...list(config.SQUIRMY_MANAGED_LIBRARY_PATHS).map((requested) => ({ requested, mode: 'managed' as const, variable: 'SQUIRMY_MANAGED_LIBRARY_PATHS' })),
    ...list(config.SQUIRMY_LIBRARY_PATHS).map((requested) => ({ requested, mode: 'read_only' as const, variable: 'SQUIRMY_LIBRARY_PATHS' })),
  ]
  for (const { requested, mode, variable } of configured) {
    try {
      const resolved = await resolveRootPath(requested)
      const [existing] = await db.select({ id: libraryRoots.id }).from(libraryRoots).where(eq(libraryRoots.path, resolved))
      if (existing) continue
      const root = await insertRoot({ name: path.basename(resolved) || resolved, path: resolved, mode, watch: true })
      await requestScan(root.id)
    } catch (error) {
      warn(`Not adding ${requested} from ${variable}: ${(error as Error).message}`)
    }
  }
}
