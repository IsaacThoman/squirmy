import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { fileMoves, mediaFiles } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'
import { assertPathFree, describe, isLibraryFile, moveTempPath, type FileRow } from './apply.js'
import { lstatOrNull, moveFile, MoveError, realFileOps, removeEmptyDirectory, type FileOps } from './files.js'
import { assertManaged, deepestFirst, loadBatch, NOT_REVERTED, setBatch, withRootLock, type MoveRow } from './journal.js'
import { resolveInRoot } from './template.js'

type Context = { rootId: string; root: string; ops: FileOps }

// Timestamps on some network shares are coarse or skewed; a file only counts as
// changed when its mtime is clearly after the move.
const MTIME_SLACK_MS = 2000

/**
 * Undoes an applied batch: moves every applied file back, newest first, with the same
 * no-overwrite and cross-device rules as applying, restores `rel_path`, recreates the
 * folders the batch removed and removes the folders it created once they are empty.
 *
 * A file that was moved, changed or replaced since the batch was applied is left
 * where it is and its move keeps status `applied` with the reason. Tags the batch
 * wrote are not restored. Resumable like {@link applyBatch}; the batch ends `reverted`.
 */
export async function revertBatch(batchId: string, options: { ops?: FileOps } = {}): Promise<void> {
  const { batch, root } = await loadBatch(batchId)
  if (batch.status === 'reverted') return
  if (batch.status !== 'applied' && batch.status !== 'reverting') throw conflict('Only an applied batch can be undone', 'batch_not_applied')
  assertManaged(root)

  await withRootLock(root.id, async () => {
    const { batch: current } = await loadBatch(batchId)
    if (current.status !== 'applied' && current.status !== 'reverting') return
    await setBatch(batchId, { status: 'reverting' })

    const context: Context = { rootId: root.id, root: path.resolve(root.path), ops: options.ops ?? realFileOps }
    const moves = await db.select().from(fileMoves)
      .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.status, 'applied'), inArray(fileMoves.kind, ['audio', 'sidecar'])))
      .orderBy(desc(fileMoves.id))
    for (const move of moves) await revertMove(context, move)
    await restoreDirectories(context, batchId)
    await setBatch(batchId, { status: 'reverted', revertedAt: new Date() })
  })
}

async function revertMove(context: Context, move: MoveRow) {
  let file: FileRow | null = null
  if (move.fromRelPath !== move.toRelPath) {
    try {
      file = await filesystemStep(context, move)
    } catch (error) {
      await db.update(fileMoves).set({ error: NOT_REVERTED + describe(error) }).where(eq(fileMoves.id, move.id))
      return
    }
  }
  await db.transaction(async (tx) => {
    if (file) await tx.update(mediaFiles).set({ relPath: move.fromRelPath, updatedAt: new Date() }).where(eq(mediaFiles.id, file.id))
    await tx.update(fileMoves).set({ status: 'reverted', revertedAt: new Date() }).where(eq(fileMoves.id, move.id))
  })
}

async function filesystemStep(context: Context, move: MoveRow): Promise<FileRow | null> {
  const original = resolveInRoot(context.root, move.fromRelPath)
  const current = resolveInRoot(context.root, move.toRelPath)
  let file: FileRow | null = null
  if (move.kind === 'audio') {
    const [row] = move.fileId ? await db.select().from(mediaFiles).where(eq(mediaFiles.id, move.fileId)) : []
    if (!row || row.rootId !== context.rootId) throw new MoveError('The file is no longer in the library')
    if (row.relPath !== move.toRelPath) throw new MoveError('The file has been moved since the batch was applied')
    await assertPathFree(context, row, move.fromRelPath)
    file = row
  }

  const stats = await lstatOrNull(current)
  if (stats && changedSince(stats, move, file)) throw new MoveError('The file has changed since the batch was applied')
  await moveFile(current, original, {
    temp: moveTempPath(original, move.id),
    ops: context.ops,
    ensureDirectory: (directory) => mkdir(directory, { recursive: true }).then(() => {}),
    isMovedFile: (_, found) => (file ? isLibraryFile(file, original, found) : Promise.resolve(found.isFile())),
  })
  return file
}

function changedSince(stats: Stats, move: MoveRow, file: FileRow | null): boolean {
  if (!stats.isFile()) return true
  if (move.appliedAt && stats.mtimeMs > move.appliedAt.getTime() + MTIME_SLACK_MS) return true
  return file !== null && stats.size !== file.size
}

/** Recreates folders the batch removed, then removes the folders it created that are now empty, deepest first. */
async function restoreDirectories(context: Context, batchId: string) {
  const rows = await db.select().from(fileMoves)
    .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.kind, 'directory'), eq(fileMoves.status, 'applied')))
  for (const row of rows.filter((dir) => dir.toRelPath === '')) {
    await mkdir(resolveInRoot(context.root, row.fromRelPath), { recursive: true })
    await db.update(fileMoves).set({ status: 'reverted', revertedAt: new Date() }).where(eq(fileMoves.id, row.id))
  }
  for (const row of rows.filter((dir) => dir.fromRelPath === '').sort((a, b) => deepestFirst(a.toRelPath, b.toRelPath))) {
    const absolute = resolveInRoot(context.root, row.toRelPath)
    if (await lstatOrNull(absolute) && !await removeEmptyDirectory(absolute)) {
      await db.update(fileMoves).set({ error: `${NOT_REVERTED}The folder is not empty` }).where(eq(fileMoves.id, row.id))
      continue
    }
    await db.update(fileMoves).set({ status: 'reverted', revertedAt: new Date() }).where(eq(fileMoves.id, row.id))
  }
}
