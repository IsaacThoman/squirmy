import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryRoot, LibraryRootMode, ScanStats } from '@squirmy/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, type Executor } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { validateTemplate } from '../organize/template.js'
import { warn } from './progress.js'

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
    for (const existing of await tx.select({ path: libraryRoots.path }).from(libraryRoots)) {
      if (existing.path === input.path) throw conflict('That folder is already a library root', 'duplicate_root')
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
    scanning: sql<boolean>`exists (select 1 from pgboss.job j where j.name = 'library.scan' and j.singleton_key = library_roots.id::text and j.state in ('created', 'retry', 'active'))`,
  }).from(libraryRoots).where(id ? eq(libraryRoots.id, id) : undefined).orderBy(asc(libraryRoots.name), asc(libraryRoots.createdAt))
  return rows.map(({ root, fileCount, scanning }) => ({
    id: root.id,
    name: root.name,
    path: root.path,
    mode: root.mode,
    enabled: root.enabled,
    watch: root.watch,
    template: root.template,
    scanning,
    fileCount,
    lastScanStartedAt: root.lastScanStartedAt?.toISOString() ?? null,
    lastScanFinishedAt: root.lastScanFinishedAt?.toISOString() ?? null,
    lastScanStats: (root.lastScanStats as ScanStats | null) ?? null,
  }))
}

/** Queues a full scan. Returns false when one is already queued or running. */
export async function requestScan(rootId: string): Promise<boolean> {
  return (await enqueue('library.scan', { rootId }, { singletonKey: rootId })) !== null
}

/**
 * Adds each folder in SQUIRMY_LIBRARY_PATHS as a read-only root, unless a root already has
 * that path, and scans the new ones. Folders that do not exist or overlap a root are
 * reported and skipped.
 */
export async function addConfiguredRoots() {
  const configured = (getConfig().SQUIRMY_LIBRARY_PATHS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  for (const requested of configured) {
    try {
      const resolved = await resolveRootPath(requested)
      const [existing] = await db.select({ id: libraryRoots.id }).from(libraryRoots).where(eq(libraryRoots.path, resolved))
      if (existing) continue
      const root = await insertRoot({ name: path.basename(resolved) || resolved, path: resolved, mode: 'read_only', watch: true })
      await requestScan(root.id)
    } catch (error) {
      warn(`Not adding ${requested} from SQUIRMY_LIBRARY_PATHS: ${(error as Error).message}`)
    }
  }
}
