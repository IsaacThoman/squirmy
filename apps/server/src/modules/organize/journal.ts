import path from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { withSessionLock } from '../../database/locks.js'
import { fileMoves, libraryRoots, organizeBatches } from '../../database/schema.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'

/**
 * The organize journal: batches, their moves, and the directories a batch created or
 * removed. Directory changes are `file_moves` rows of kind `directory`:
 * `from = ''` means the batch created `to`; `to = ''` means it removed `from`.
 */

export type BatchRow = typeof organizeBatches.$inferSelect
export type MoveRow = typeof fileMoves.$inferSelect
export type BatchOptions = { albumIds?: string[]; includeUnmatched: boolean; writeTags: boolean; template: string }

/** Prefix of `file_moves.error` on an applied audio move whose tags were not written. */
export const TAGS_NOT_WRITTEN = 'Tags not written: '
/** Prefix of `file_moves.error` on an applied move that undo left in place. */
export const NOT_REVERTED = 'Not undone: '

export async function loadBatch(batchId: string) {
  const [row] = await db.select({ batch: organizeBatches, root: libraryRoots }).from(organizeBatches)
    .innerJoin(libraryRoots, eq(libraryRoots.id, organizeBatches.rootId))
    .where(eq(organizeBatches.id, batchId))
  if (!row) throw notFound('Organize batch not found', 'batch_not_found')
  return { ...row, options: row.batch.options as BatchOptions }
}

/** Refuses to touch a root that is not (or no longer) managed. */
export function assertManaged(root: typeof libraryRoots.$inferSelect) {
  if (root.mode !== 'managed') throw badRequest('Only managed library roots can be organized', 'root_not_managed')
}

/**
 * Runs `work` while holding a Postgres advisory lock for the root, so only one batch
 * moves files in a root at a time, across every process. The lock is a session lock
 * (locks.ts), released if the process dies.
 */
export async function withRootLock<T>(rootId: string, work: () => Promise<T>): Promise<T> {
  const outcome = await withSessionLock(`squirmy.organize:${rootId}`, work)
  if (!outcome.locked) throw conflict('Another organize batch is running in this library root', 'organize_busy')
  return outcome.value
}

/**
 * Records that the batch is about to create `directory` (relative to the root). The
 * row is written before the directory exists, so a crash can only leave a record of a
 * directory that was never made, which undo tolerates.
 */
export async function recordCreatedDirectory(batchId: string, directory: string) {
  await recordDirectory(batchId, '', directory)
}

/** Records that the batch is about to remove the now-empty `directory`. Undo recreates it. */
export async function recordRemovedDirectory(batchId: string, directory: string) {
  await recordDirectory(batchId, directory, '')
}

async function recordDirectory(batchId: string, from: string, to: string) {
  const existing = await db.select({ id: fileMoves.id }).from(fileMoves).where(and(
    eq(fileMoves.batchId, batchId), eq(fileMoves.kind, 'directory'), eq(fileMoves.fromRelPath, from), eq(fileMoves.toRelPath, to),
  ))
  if (existing.length > 0) {
    await db.update(fileMoves).set({ status: 'applied', appliedAt: new Date(), revertedAt: null })
      .where(inArray(fileMoves.id, existing.map((row) => row.id)))
    return
  }
  await db.insert(fileMoves).values({ id: newId(), batchId, kind: 'directory', fromRelPath: from, toRelPath: to, status: 'applied', appliedAt: new Date() })
}

/** Every ancestor directory of a relative path, deepest first, excluding the root. */
export function ancestors(relPath: string): string[] {
  const out: string[] = []
  for (let dir = path.posix.dirname(relPath); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) out.push(dir)
  return out
}

/** Sorts relative directories deepest first. */
export const deepestFirst = (a: string, b: string) => b.split('/').length - a.split('/').length || b.localeCompare(a)

export async function setBatch(batchId: string, values: Partial<typeof organizeBatches.$inferInsert>) {
  await db.update(organizeBatches).set(values).where(eq(organizeBatches.id, batchId))
}
