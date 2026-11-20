import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Stats } from 'node:fs'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { fileMoves, mediaFiles } from '../../database/schema.js'
import { audioHash } from '../../lib/ffmpeg.js'
import {
  errorCode, lstatOrNull, moveFile, MoveError, readdirOrEmpty, realFileOps, removeEmptyDirectory, type FileOps,
} from './files.js'
import {
  ancestors, assertManaged, deepestFirst, loadBatch, recordCreatedDirectory, recordRemovedDirectory, setBatch, TAGS_NOT_WRITTEN,
  withRootLock, type MoveRow,
} from './journal.js'
import { catalogTagValues, writeTags, writtenFileTags } from './tags.js'
import { resolveInRoot } from './template.js'

export type FileRow = typeof mediaFiles.$inferSelect

type Context = { batchId: string; rootId: string; root: string; ops: FileOps; writeTags: boolean }

/** The temp name a move's cross-device copy uses, in the destination directory. */
export const moveTempPath = (destination: string, moveId: string) => path.join(path.dirname(destination), `.squirmy-move-${moveId}.tmp`)
/** The temp name for a file's tag-writing copy. It keeps the extension, which the tag library goes by. */
export const tagTempPath = (file: string, moveId: string) => path.join(path.dirname(file), `.squirmy-tags-${moveId}${path.extname(file).toLowerCase()}`)

/**
 * Applies a planned batch: moves every planned file (and writes tags when the batch
 * asks for it), then removes source folders left empty. Each move updates the database
 * only after its file-system step succeeded, in one transaction per file.
 *
 * Resumable: after a crash, calling it again reconciles each unfinished move with what
 * is on disk and carries on. A move that cannot be done is marked failed with its
 * reason and the batch continues. The batch ends `applied`, or `failed` when every
 * attempted move failed. A batch that is already past applying is left as it is.
 */
export async function applyBatch(batchId: string, options: { ops?: FileOps } = {}): Promise<void> {
  const { batch, root, options: batchOptions } = await loadBatch(batchId)
  if (batch.status !== 'planned' && batch.status !== 'applying') return
  assertManaged(root)

  await withRootLock(root.id, async () => {
    const { batch: current } = await loadBatch(batchId)
    if (current.status !== 'planned' && current.status !== 'applying') return
    await setBatch(batchId, { status: 'applying' })

    const context: Context = { batchId, rootId: root.id, root: path.resolve(root.path), ops: options.ops ?? realFileOps, writeTags: batchOptions.writeTags }
    const moves = await db.select().from(fileMoves)
      .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.status, 'planned'), inArray(fileMoves.kind, ['audio', 'sidecar'])))
      .orderBy(asc(fileMoves.id))
    for (const move of moves.filter((row) => row.kind === 'audio')) await applyMove(context, move)
    // Sidecars only follow a folder whose audio all arrived; otherwise they stay with what is left.
    const stranded = new Set((await db.select({ from: fileMoves.fromRelPath }).from(fileMoves)
      .where(and(eq(fileMoves.batchId, batchId), eq(fileMoves.kind, 'audio'), ne(fileMoves.status, 'applied'))))
      .map((row) => path.posix.dirname(row.from)))
    for (const move of moves.filter((row) => row.kind === 'sidecar')) {
      if (stranded.has(path.posix.dirname(move.fromRelPath))) {
        await db.update(fileMoves).set({ status: 'skipped', error: 'An audio file in its folder did not move' }).where(eq(fileMoves.id, move.id))
      } else await applyMove(context, move)
    }
    await removeEmptyDirectories(context)

    const rows = await db.select({ kind: fileMoves.kind, status: fileMoves.status, error: fileMoves.error }).from(fileMoves)
      .where(and(eq(fileMoves.batchId, batchId), inArray(fileMoves.kind, ['audio', 'sidecar'])))
    const applied = rows.filter((row) => row.status === 'applied')
    const failed = rows.filter((row) => row.status === 'failed').length
    const audio = applied.filter((row) => row.kind === 'audio')
    const tagsSkipped = audio.filter((row) => row.error?.startsWith(TAGS_NOT_WRITTEN)).length
    await setBatch(batchId, {
      status: applied.length === 0 && failed > 0 ? 'failed' : 'applied',
      appliedAt: new Date(),
      stats: {
        ...current.stats,
        tagsWritten: batchOptions.writeTags ? audio.length - tagsSkipped : 0,
        tagsSkipped,
      },
    })
  })
}

async function applyMove(context: Context, move: MoveRow) {
  let file: FileRow | null
  try {
    file = await moveStep(context, move)
  } catch (error) {
    await db.update(fileMoves).set({ status: 'failed', error: describe(error) }).where(eq(fileMoves.id, move.id))
    return
  }
  // From here on the file is at its destination. Errors leave the move planned, and the
  // next run finds the file in place and records it; tag problems are only a reason.
  const tags = file && context.writeTags ? await tagStep(context, move, file) : null
  await db.transaction(async (tx) => {
    if (file) {
      await tx.update(mediaFiles).set({
        relPath: move.toRelPath,
        updatedAt: new Date(),
        ...(tags?.written ? { size: tags.size, mtime: tags.mtime, tags: { ...file.tags, ...tags.fileTags } } : {}),
      }).where(eq(mediaFiles.id, file.id))
    }
    await tx.update(fileMoves).set({
      status: 'applied',
      appliedAt: new Date(),
      error: tags && !tags.written ? TAGS_NOT_WRITTEN + tags.reason : null,
    }).where(eq(fileMoves.id, move.id))
  })
}

/** Moves the file (unless only its tags change) and returns its library row, for audio. */
async function moveStep(context: Context, move: MoveRow): Promise<FileRow | null> {
  const from = resolveInRoot(context.root, move.fromRelPath)
  const to = resolveInRoot(context.root, move.toRelPath)
  const file = move.kind === 'audio' ? await movingFile(context, move) : null
  if (from === to) return file
  if (file) await assertPathFree(context, file, move.toRelPath)
  await moveFile(from, to, {
    temp: moveTempPath(to, move.id),
    ops: context.ops,
    ensureDirectory: (directory) => createDirectory(context, directory),
    isMovedFile: (_, stats) => (file ? isLibraryFile(file, to, stats) : Promise.resolve(stats.isFile())),
  })
  return file
}

/** Writes catalog tags into the moved file. Never throws for problems with the file itself. */
async function tagStep(context: Context, move: MoveRow, file: FileRow) {
  const values = file.matchStatus === 'matched' || file.matchLocked ? await catalogTagValues(file.id) : null
  if (!values) return { written: false as const, reason: 'Only confidently identified files get tags' }
  const to = resolveInRoot(context.root, move.toRelPath)
  const result = await writeTags(to, values, { temp: tagTempPath(to, move.id), expectedAudioHash: file.audioHash })
  return result.written ? { ...result, fileTags: writtenFileTags(values) } : result
}

/** The library row for an audio move, if it still describes the file the batch planned to move. */
async function movingFile(context: Context, move: MoveRow): Promise<FileRow> {
  const [file] = move.fileId ? await db.select().from(mediaFiles).where(eq(mediaFiles.id, move.fileId)) : []
  if (!file || file.rootId !== context.rootId) throw new MoveError('The file is no longer in the library')
  if (file.missingSince) throw new MoveError('The library has marked this file missing')
  if (file.relPath !== move.fromRelPath) throw new MoveError('The file has moved since the batch was planned')
  return file
}

/** Refuses a destination another library row already has (the database would refuse it too, after the move). */
export async function assertPathFree(context: { rootId: string }, file: FileRow, relPath: string) {
  const [other] = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, context.rootId), eq(mediaFiles.relPath, relPath), ne(mediaFiles.id, file.id)))
  if (other) throw new MoveError('Another library file has that path')
}

/**
 * Whether the file found at a destination is the library file being moved, judged by
 * its size, or by its audio hash when its tags were rewritten.
 */
export async function isLibraryFile(file: FileRow, at: string, stats: Stats): Promise<boolean> {
  if (!stats.isFile()) return false
  if (stats.size === file.size) return true
  return file.audioHash !== null && await audioHash(at) === file.audioHash
}

/** Creates a destination directory and its missing parents, journaling each one before it exists. */
async function createDirectory(context: Context, directory: string) {
  const missing: string[] = []
  for (let dir = directory; dir !== context.root; dir = path.dirname(dir)) {
    if (await lstatOrNull(dir)) break
    missing.unshift(dir)
  }
  for (const dir of missing) {
    await recordCreatedDirectory(context.batchId, relative(context, dir))
    await mkdir(dir).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error
    })
  }
}

/**
 * Removes source folders the batch emptied (journaled so undo recreates them), and
 * folders the batch created for moves that then failed.
 */
async function removeEmptyDirectories(context: Context) {
  const rows = await db.select().from(fileMoves).where(and(eq(fileMoves.batchId, context.batchId), eq(fileMoves.status, 'applied')))
  const sources = new Set(rows.filter((row) => row.kind !== 'directory' && row.fromRelPath !== row.toRelPath).flatMap((row) => ancestors(row.fromRelPath)))
  for (const dir of [...sources].sort(deepestFirst)) {
    const absolute = resolveInRoot(context.root, dir)
    const stats = await lstatOrNull(absolute)
    if (!stats?.isDirectory() || (await readdirOrEmpty(absolute)).length > 0) continue
    await recordRemovedDirectory(context.batchId, dir)
    await removeEmptyDirectory(absolute)
  }
  const created = rows.filter((row) => row.kind === 'directory' && row.fromRelPath === '').sort((a, b) => deepestFirst(a.toRelPath, b.toRelPath))
  for (const row of created) {
    const absolute = resolveInRoot(context.root, row.toRelPath)
    if (await lstatOrNull(absolute) && !await removeEmptyDirectory(absolute)) continue
    await db.update(fileMoves).set({ status: 'reverted', revertedAt: new Date() }).where(eq(fileMoves.id, row.id))
  }
}

const relative = (context: { root: string }, absolute: string) => path.relative(context.root, absolute).split(path.sep).join('/')

/** The admin-facing reason for a failed step. */
export function describe(error: unknown): string {
  if (error instanceof MoveError) return error.message
  const code = errorCode(error)
  const known: Record<string, string> = {
    EACCES: 'Permission denied',
    EPERM: 'Operation not permitted',
    ENOSPC: 'The disk is full',
    EROFS: 'The file system is read-only',
    ENAMETOOLONG: 'The path is too long for this file system',
    ENOTDIR: 'A file is in the way of a folder on the path',
    EEXIST: 'Something already exists at the destination',
  }
  return (code && known[code]) ?? (error instanceof Error ? error.message : String(error))
}
