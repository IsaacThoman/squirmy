/**
 * Deleting a file from the server for good: from disk, its `media_files` row, then the
 * local-only catalog rows it leaves unused (`removeOrphans`), exactly as a purge of a
 * missing file would. Catalog albums and recordings with a MusicBrainz id, or that someone
 * saved, stay. Used by the provider cache's eviction (acquisition/evict.ts) and by deleting
 * uploads (imports/uploads.ts).
 *
 * Only files in a managed root are ever deleted: a read-only root is never written to.
 *
 * Folders: inside `_Fetched/` or `_Incoming/` (and anywhere in the root with `tidy:
 * 'anywhere'`, for uploads filed under the root's template), the file takes its sidecars
 * (cover, lyrics) and then its folder with it once no other file is there, and then the
 * empty folders above it. A folder holding anything but sidecars is left as it is.
 */
import { readdir, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { FETCHED_FOLDER, INCOMING_FOLDER } from '@squirmy/contracts'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, type Transaction } from '../../database/client.js'
import { libraryRoots, mediaFiles } from '../../database/schema.js'
import { fileKind } from '../imports/paths.js'
import { lockCatalog, removeOrphans } from './cleanup.js'

export type DeletedFile = typeof mediaFiles.$inferSelect

export type DeleteOptions = {
  /** Further conditions the file must meet, checked under the row lock (on `media_files`). */
  where?: SQL
  /** Validates a file under the same catalog lock before touching disk. */
  beforeUnlink?: (tx: Transaction, file: DeletedFile) => Promise<void>
  /** Runs in the transaction after the row is deleted and before orphans are removed. */
  beforeOrphans?: (tx: Transaction, file: DeletedFile) => Promise<void>
  /** Where the file's folder is tidied: only under `_Fetched/` and `_Incoming/` (the default), or anywhere in the root. */
  tidy?: 'staging' | 'anywhere' | false
}

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[library]', error)
}

/**
 * Deletes one present file in a managed root from disk and the database. Null when the file
 * is gone, not present, outside a managed root, or fails `where`. Throws when the file
 * cannot be deleted from disk; its row is kept.
 */
export async function deleteLibraryFile(fileId: string, options: DeleteOptions = {}): Promise<DeletedFile | null> {
  const removed = await db.transaction(async (tx) => {
    // Ingest, matching and the purge relink and delete the same rows; take their lock first.
    await lockCatalog(tx)
    const [row] = await tx.select({ file: mediaFiles, rootPath: libraryRoots.path }).from(mediaFiles)
      .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
      .where(and(eq(mediaFiles.id, fileId), sql`${mediaFiles.missingSince} is null`, eq(libraryRoots.mode, 'managed'), options.where))
      .for('update', { of: mediaFiles })
    if (!row) return null
    await options.beforeUnlink?.(tx, row.file)
    await unlink(path.join(row.rootPath, row.file.relPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await tx.delete(mediaFiles).where(eq(mediaFiles.id, fileId))
    await options.beforeOrphans?.(tx, row.file)
    await removeOrphans(tx, { albumIds: [row.file.albumId], releaseIds: [row.file.releaseId], recordingIds: [row.file.recordingId] })
    return row
  })
  if (!removed) return null
  if (options.tidy !== false) await tidyFolder(removed.file.rootId, removed.rootPath, removed.file.relPath, options.tidy ?? 'staging').catch(report)
  return removed.file
}

/**
 * After deleting `relPath`: removes the folder's sidecars and the folder once no other file
 * of the root is there (by row or on disk), then empty parents up to the top folder
 * (`_Fetched` or `_Incoming`, or the root itself with `anywhere`). Elsewhere it changes nothing more.
 */
async function tidyFolder(rootId: string, rootPath: string, relPath: string, tidy: 'staging' | 'anywhere') {
  const first = relPath.split('/')[0]!
  const staged = first === FETCHED_FOLDER || first === INCOMING_FOLDER
  if (!staged && tidy !== 'anywhere') return
  const top = staged ? first : '.'
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
