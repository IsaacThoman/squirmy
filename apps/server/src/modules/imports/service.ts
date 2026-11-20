import { link, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  Id, INCOMING_FOLDER, ImportUnavailable,
  type Import, type ImportAlbum, type ImportCounts, type ImportFileRejection, type ImportFileResult, type ImportKind, type ImportList, type ImportListQuery,
  type ImportOptions,
} from '@squirmy/contracts'
import { and, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { acquisitionJobs, imports, libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import type { AuthUser } from '../../lib/auth.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { publish } from '../../realtime/index.js'
import { albumSummaries } from '../catalog/summaries.js'
import { errorCode } from '../organize/files.js'
import { checkRelativePath } from './paths.js'
import { moveTree, stagingDir, TEMP_PREFIX, TooLargeError, writeLimited } from './staging.js'

export type ImportRow = typeof imports.$inferSelect
type RootRow = typeof libraryRoots.$inferSelect

/** Bookkeeping in `imports.work` that lets processing resume after a crash. */
export type ImportWork = {
  /** Per staged archive (by its staged path): where it extracts to, or why it was refused. */
  archives?: Record<string, { target?: string; rejected?: string; extracted?: number; skipped?: number; done?: boolean }>
  /** The files identification decided were duplicates, by path, so a rerun can finish removing them. */
  duplicates?: string[]
  /** The organize batch that files the import's identified albums. */
  batchId?: string
  /** The inbox an inbox import came from, so a failed one can be put back. */
  inboxPath?: string
  /** Files refused by name while receiving. */
  rejectedOnReceipt?: number
  timedOut?: boolean
}

const emptyCounts: ImportCounts = {
  filesReceived: 0, bytesReceived: 0, filesRejected: 0, filesExtracted: 0, archivesRejected: 0, audioFiles: 0,
  duplicatesSkipped: 0, unreadable: 0, albumsIdentified: 0, albumsFiled: 0, filesFiled: 0, filesLeftForReview: 0,
}

/** The folder of a root that holds an import's files until they are filed. */
export const incomingFolder = (importId: string) => `${INCOMING_FOLDER}/${importId}`

export const fileTooLarge = (limit: number) => new AppError(413, 'file_too_large', `Files may be at most ${limit} bytes`, { limit })
export const importTooLarge = (limit: number) => new AppError(413, 'import_too_large', `An import may be at most ${limit} bytes`, { limit })
const notReceiving = () => conflict('The import is no longer receiving files', 'import_not_receiving')

/** The API shape of an import row. */
export function toImport(row: ImportRow): Import {
  const work = (row.work ?? {}) as ImportWork
  const counts: ImportCounts = {
    ...emptyCounts,
    filesRejected: work.rejectedOnReceipt ?? 0,
    ...row.stats,
    filesReceived: row.receivedFiles,
    bytesReceived: row.receivedBytes,
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    step: row.status === 'processing' ? row.step : null,
    label: row.label,
    userId: row.userId,
    acquisitionJobId: row.acquisitionJobId,
    targetRootId: row.targetRootId,
    counts,
    timedOut: work.timedOut ?? false,
    reviewFolder: row.status === 'completed' && counts.filesLeftForReview > 0 ? incomingFolder(row.id) : null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

/** Sends `import.updated` to the import's owner and to admins. Works from any process. */
export async function announceImport(row: Pick<ImportRow, 'id' | 'userId' | 'status'>) {
  const event = { type: 'import.updated' as const, importId: row.id, status: row.status }
  await publish(row.userId ? [{ user: row.userId }, 'admins'] : 'admins', event)
}

export async function loadImport(importId: string): Promise<ImportRow> {
  const [row] = Id.safeParse(importId).success ? await db.select().from(imports).where(eq(imports.id, importId)) : []
  if (!row) throw notFound('No such import', 'import_not_found')
  return row
}

/**
 * The managed root imports are filed into: `rootId` when given, else the `importRootId` setting, else the only
 * enabled managed root. Fails with `no_managed_root`, `import_root_not_set` (several
 * managed roots and no choice made) or `import_root_unavailable` (the chosen root is gone,
 * disabled or not managed).
 */
export async function resolveImportRoot(rootId?: string | null): Promise<RootRow> {
  const importRootId = rootId ?? (await getServerSettings()).importRootId
  const managed = await db.select().from(libraryRoots).where(and(eq(libraryRoots.mode, 'managed'), eq(libraryRoots.enabled, true)))
  if (importRootId) {
    const chosen = managed.find((root) => root.id === importRootId)
    if (!chosen) throw conflict('The library root chosen for imports is not an enabled managed root', 'import_root_unavailable')
    return chosen
  }
  if (managed.length === 0) throw conflict('Imports need a managed library root to file music into. Add one first.', 'no_managed_root')
  if (managed.length > 1) throw conflict('Choose which managed library root imports go to in the server settings', 'import_root_not_set')
  return managed[0]!
}

/** The upload limits, and the reason uploads cannot start when there is no root to file into. */
export async function importOptions(): Promise<ImportOptions> {
  const { importMaxFileBytes, importMaxBytes } = await getServerSettings()
  let unavailable: ImportUnavailable | null = null
  try {
    await resolveImportRoot()
  } catch (error) {
    const reason = error instanceof AppError ? ImportUnavailable.safeParse(error.code) : null
    if (!reason?.success) throw error
    unavailable = reason.data
  }
  return { unavailable, maxFileBytes: importMaxFileBytes, maxBytes: importMaxBytes }
}

export type CreateImportInput = {
  kind: ImportKind
  userId: string | null
  /** Required for `acquisition` imports; their files get `source = provider:<provider id>`. */
  acquisitionJobId?: string
  label?: string
  /** A managed root to file into instead of the one imports normally use. */
  rootId?: string | null
}

/**
 * Starts an import in `receiving`, with an empty staging folder. Fails when there is no
 * managed root to file into (see {@link resolveImportRoot}).
 */
export async function createImport(input: CreateImportInput): Promise<Import> {
  const root = await resolveImportRoot(input.rootId)
  let source: string = input.kind
  if (input.kind === 'acquisition') {
    const [job] = input.acquisitionJobId ? await db.select({ providerId: acquisitionJobs.providerId }).from(acquisitionJobs).where(eq(acquisitionJobs.id, input.acquisitionJobId)) : []
    if (!job) throw badRequest('An acquisition import needs its acquisition job', 'acquisition_job_not_found')
    source = `provider:${job.providerId}`
  }
  const id = newId()
  const staging = stagingDir(id)
  await mkdir(staging, { recursive: true })
  const [row] = await db.insert(imports).values({
    id, kind: input.kind, source, userId: input.userId, acquisitionJobId: input.acquisitionJobId ?? null,
    targetRootId: root.id, label: input.label ?? null, stagingPath: staging,
  }).returning()
  await announceImport(row!)
  return toImport(row!)
}

export type ImportFileInput = {
  /** The file's own name, used when `relativePath` is absent. */
  filename: string
  /** Where the file goes inside the import, including its name: `Album/CD1/01 Song.flac`. */
  relativePath?: string
  stream: Readable
  /** A per-file limit stricter than `importMaxFileBytes`, such as the acquisition policy's. */
  maxFileBytes?: number
}

/**
 * Streams one file into the import's staging folder. Files are refused by name (see
 * `checkRelativePath`) or when the import already has one at that path; the stream is then
 * drained and the result says why. A file over `importMaxFileBytes` (or `maxFileBytes`), or one that would take
 * the import past `importMaxBytes`, throws 413 (`file_too_large`, `import_too_large`).
 *
 * The bytes land in a temporary file first. The import's counters are bumped and the file
 * is linked into place in one transaction that holds the import's row, so a concurrent
 * commit or cancel either sees the whole file or none of it.
 */
export async function addImportFile(importId: string, input: ImportFileInput): Promise<ImportFileResult> {
  const row = await loadImport(importId)
  const requested = input.relativePath?.trim() ? input.relativePath : input.filename
  const reject = async (reason: ImportFileRejection, filePath: string): Promise<ImportFileResult> => {
    // Hidden files are skipped quietly; the rest count as refused.
    if (reason !== 'hidden') await countRejection(importId)
    return { path: filePath, status: 'rejected', reason, bytes: 0 }
  }
  if (row.status !== 'receiving') throw notReceiving()
  const checked = checkRelativePath(requested)
  if (!checked.ok) {
    input.stream.resume()
    await finished(input.stream).catch(() => {})
    return reject(checked.reason, requested)
  }

  const settings = await getServerSettings()
  const importMaxBytes = settings.importMaxBytes
  const importMaxFileBytes = Math.min(settings.importMaxFileBytes, input.maxFileBytes ?? Infinity)
  const temp = path.join(row.stagingPath, `${TEMP_PREFIX}upload-${newId()}.part`)
  await mkdir(row.stagingPath, { recursive: true })
  let bytes: number
  try {
    bytes = await writeLimited(input.stream, temp, Math.min(importMaxFileBytes, importMaxBytes - row.receivedBytes))
  } catch (error) {
    if (!(error instanceof TooLargeError) && (error as { code?: string }).code !== 'FST_REQ_FILE_TOO_LARGE') throw error
    throw importMaxBytes - row.receivedBytes < importMaxFileBytes ? importTooLarge(importMaxBytes) : fileTooLarge(importMaxFileBytes)
  }

  const target = path.join(row.stagingPath, checked.path)
  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx.update(imports)
        .set({ receivedFiles: sql`${imports.receivedFiles} + 1`, receivedBytes: sql`${imports.receivedBytes} + ${bytes}`, updatedAt: new Date() })
        .where(and(eq(imports.id, importId), eq(imports.status, 'receiving')))
        .returning({ receivedBytes: imports.receivedBytes })
      if (!updated) throw notReceiving()
      if (updated.receivedBytes > importMaxBytes) throw importTooLarge(importMaxBytes)
      try {
        await mkdir(path.dirname(target), { recursive: true })
        await placeNew(temp, target)
      } catch (error) {
        if (['EEXIST', 'ENOTDIR'].includes(errorCode(error) ?? '')) throw new DuplicateName()
        throw error
      }
      return { path: checked.path, status: 'accepted', reason: null, bytes } satisfies ImportFileResult
    })
  } catch (error) {
    if (error instanceof DuplicateName) return reject('duplicate_name', checked.path)
    throw error
  } finally {
    await rm(temp, { force: true })
  }
}

class DuplicateName extends Error {}

async function countRejection(importId: string) {
  await db.update(imports).set({
    work: sql`jsonb_set(coalesce(${imports.work}, '{}'), '{rejectedOnReceipt}', to_jsonb(coalesce((${imports.work}->>'rejectedOnReceipt')::int, 0) + 1))`,
    updatedAt: new Date(),
  }).where(eq(imports.id, importId))
}

/** Puts `from` at `to` without replacing anything there: a hard link where the file system has them. */
async function placeNew(from: string, to: string) {
  try {
    await link(from, to)
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(errorCode(error) ?? '')) throw error
    // The transaction holds the import's row, so no other upload to it gets in between.
    if (await lstat(to).then(() => true, () => false)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    await rename(from, to)
  }
}

/**
 * Ends receiving and queues `imports.process`, in one transaction. Fails with
 * `import_not_receiving` when it is past receiving and `import_empty` when no file arrived.
 */
export async function commitImport(importId: string): Promise<Import> {
  const row = await loadImport(importId)
  if (row.status !== 'receiving') throw notReceiving()
  if (row.receivedFiles === 0) throw badRequest('The import has no files', 'import_empty')
  const committed = await db.transaction(async (tx) => {
    const [updated] = await tx.update(imports).set({ status: 'processing', step: 'extracting', stepStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(imports.id, importId), eq(imports.status, 'receiving'))).returning()
    if (!updated) throw notReceiving()
    await enqueue('imports.process', { importId }, { singletonKey: importId, tx })
    return updated
  })
  await announceImport(committed)
  return toImport(committed)
}

/**
 * Fails an import that is still receiving (a provider gave up, a user cancelled, it
 * expired) and removes its staging folder. An inbox import's files go back to the inbox
 * instead, into `Not imported/<importId>/`. Fails with `import_not_receiving` once it is past
 * receiving.
 */
export async function failImport(importId: string, reason: string): Promise<Import> {
  const [row] = await db.update(imports).set({ status: 'failed', step: null, error: reason, updatedAt: new Date(), completedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.status, 'receiving'))).returning()
  if (!row) {
    await loadImport(importId)
    throw notReceiving()
  }
  await releaseStaging(row)
  await announceImport(row)
  return toImport(row)
}

/** Folder in the inbox for what the server could not import. The inbox watcher ignores it. */
export const SET_ASIDE_FOLDER = 'Not imported'

/** Removes a finished import's staging folder, putting an inbox import's files back first. */
export async function releaseStaging(row: ImportRow) {
  const inbox = ((row.work ?? {}) as ImportWork).inboxPath
  if (row.kind === 'inbox' && inbox && (await readdir(row.stagingPath).catch(() => [])).length > 0) {
    try {
      await moveTree(row.stagingPath, path.join(inbox, SET_ASIDE_FOLDER, row.id))
      return
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      console.warn(`[imports] Could not return ${row.stagingPath} to the inbox`, error)
    }
  }
  await rm(row.stagingPath, { recursive: true, force: true })
}

/** One import, for the service's callers. Fails with `import_not_found`. */
export async function getImport(importId: string): Promise<Import> {
  return toImport(await loadImport(importId))
}

/** Uploading is for admins and members with the upload flag. */
export function canImport(user: AuthUser): boolean {
  return user.role === 'admin' || user.canUpload
}

/** The import, when `user` may see and change it: its owner or an admin. Others get 404. */
export async function importFor(user: AuthUser, importId: string): Promise<ImportRow> {
  const row = await loadImport(importId)
  if (user.role !== 'admin' && row.userId !== user.id) throw notFound('No such import', 'import_not_found')
  return row
}

/** A page of imports, newest first: the user's own, or everyone's for an admin. */
export async function listImports(user: AuthUser, query: ImportListQuery): Promise<ImportList> {
  if (!canImport(user)) throw forbidden()
  if (query.cursor && !Id.safeParse(query.cursor).success) throw badRequest('Invalid cursor', 'invalid_cursor')
  const rows = await db.select().from(imports).where(and(
    user.role === 'admin' ? undefined : eq(imports.userId, user.id),
    query.status ? eq(imports.status, query.status) : undefined,
    query.cursor ? lt(imports.id, query.cursor) : undefined,
  )).orderBy(desc(imports.id)).limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  return { items: page.map(toImport), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
}

/**
 * The albums an import's present audio files belong to, in title order. An album is filed
 * once none of its files from the import is left in `_Incoming/<importId>/`.
 */
export async function importAlbums(importId: string): Promise<ImportAlbum[]> {
  const waiting = `${incomingFolder(importId)}/`
  const rows = await db.select({
    albumId: mediaFiles.albumId,
    files: sql<number>`count(*)::int`,
    waiting: sql<number>`count(*) filter (where starts_with(${mediaFiles.relPath}, ${waiting}))::int`,
  }).from(mediaFiles)
    .where(and(eq(mediaFiles.importId, importId), isNull(mediaFiles.missingSince), isNotNull(mediaFiles.albumId)))
    .groupBy(mediaFiles.albumId)
  const summaries = await albumSummaries(rows.map((row) => row.albumId!))
  // Merged albums answer with the same summary; their files count together.
  const byAlbum = new Map<string, ImportAlbum>()
  rows.forEach((row, index) => {
    const album = summaries[index]
    if (!album) return
    const seen = byAlbum.get(album.id)
    byAlbum.set(album.id, { album, files: (seen?.files ?? 0) + row.files, filed: (seen?.filed ?? true) && row.waiting === 0 })
  })
  return [...byAlbum.values()].sort((a, b) => a.album.title.localeCompare(b.album.title))
}
