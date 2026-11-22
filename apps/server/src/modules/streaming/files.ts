import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { fileMoves, libraryRoots, mediaFiles, organizeBatches } from '../../database/schema.js'
import { AppError, forbidden, notFound } from '../../lib/errors.js'
import type { MediaFile } from './profiles.js'

/** A response ready to send: status, headers and a body (null for HEAD, 416 and similar). */
export type StreamResponse = { status: number; headers: Record<string, string>; body: Readable | null }

/** What the client sent that affects the response. */
export type StreamRequest = { range?: string; ifRange?: string; head?: boolean }

/**
 * Absolute path of a library file, with its links resolved. `rel_path` comes from the
 * scanner, but a value that climbs out of its root is refused rather than trusted, and so
 * is a file whose real path is outside the root's: whoever can write in a library folder
 * could otherwise link a file there to anything the server can read, after the scan. Links
 * that stay inside the root are followed. A file that does not exist keeps its lexical path,
 * so callers report it missing as before.
 */
export async function libraryPath(file: Pick<MediaFile, 'rootId' | 'relPath'>): Promise<string> {
  const [root] = await db.select({ path: libraryRoots.path }).from(libraryRoots).where(eq(libraryRoots.id, file.rootId))
  if (!root) throw notFound('The file is not available', 'not_available')
  const base = path.resolve(root.path)
  const full = path.resolve(base, file.relPath)
  if (!full.startsWith(base + path.sep)) throw forbidden('The file is outside its library root', 'path_outside_root')
  const real = await realpath(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (real === null) return full
  const realBase = await realpath(base)
  if (!real.startsWith(realBase + path.sep)) throw forbidden('The file is outside its library root', 'path_outside_root')
  return real
}

/**
 * Records that a file has vanished from disk; the scanner clears it if the file returns.
 * Only while its row still has the path that was tried: a row that moved on was not missing.
 */
export async function markMissing(fileId: string, relPath: string) {
  await db.update(mediaFiles).set({ missingSince: new Date(), updatedAt: new Date() })
    .where(and(eq(mediaFiles.id, fileId), eq(mediaFiles.relPath, relPath), isNull(mediaFiles.missingSince)))
}

/**
 * Paths a file that is not at `file.relPath` may be at now. Organize moves a file on disk
 * before it updates the row, and a revert does the same the other way, so a request that
 * lands in between finds it at the other end of a move that is running; and the row may
 * have changed since the caller read it.
 */
async function otherPaths(file: Pick<MediaFile, 'id' | 'relPath'>): Promise<string[]> {
  const [row] = await db.select({ relPath: mediaFiles.relPath }).from(mediaFiles).where(eq(mediaFiles.id, file.id))
  const moves = await db.select({ from: fileMoves.fromRelPath, to: fileMoves.toRelPath }).from(fileMoves)
    .innerJoin(organizeBatches, eq(organizeBatches.id, fileMoves.batchId))
    .where(and(
      eq(fileMoves.fileId, file.id), inArray(organizeBatches.status, ['applying', 'reverting']),
      or(eq(fileMoves.fromRelPath, file.relPath), eq(fileMoves.toRelPath, file.relPath)),
    ))
  const paths = [row?.relPath, ...moves.flatMap((move) => [move.from, move.to])]
  return [...new Set(paths)].filter((relPath): relPath is string => Boolean(relPath) && relPath !== file.relPath)
}

/**
 * True when the file's library root is a readable folder. A drive or share that is not
 * mounted takes every file with it; like the scanner, streaming then marks nothing missing,
 * or the library would lose those albums until a scan finds them again.
 */
async function rootAvailable(rootId: string): Promise<boolean> {
  const [root] = await db.select({ path: libraryRoots.path }).from(libraryRoots).where(eq(libraryRoots.id, rootId))
  return root ? stat(root.path).then((info) => info.isDirectory(), () => false) : false
}

/**
 * Calls `attempt` with the file's absolute path, and again at the other paths it may have
 * moved to while `attempt` answers null (not found). A stream URL handed out before
 * organize filed the file keeps working through the move. Throws 404 `file_missing`, and
 * marks the file missing, when it is nowhere; 503 `root_unavailable`, marking nothing,
 * when its whole library folder is gone.
 */
export async function withLibraryFile<T>(file: MediaFile, attempt: (absolutePath: string, file: MediaFile) => Promise<T | null>): Promise<T> {
  const found = await attempt(await libraryPath(file), file)
  if (found !== null) return found
  for (const relPath of await otherPaths(file)) {
    const moved = { ...file, relPath }
    const result = await attempt(await libraryPath(moved), moved)
    if (result !== null) return result
  }
  if (!await rootAvailable(file.rootId)) throw new AppError(503, 'root_unavailable', 'The library folder holding this file is not available')
  await markMissing(file.id, file.relPath)
  throw notFound('The file is missing from disk', 'file_missing')
}

type ByteRange = { start: number; end: number }

/**
 * Parses a single `bytes=` range against a file of `size` bytes. Returns null when the
 * header should be ignored (absent, malformed, or several ranges, which RFC 9110 lets a
 * server answer with the whole file) and 'unsatisfiable' for a 416.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  const match = header ? /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header) : null
  if (!match) return null
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return null
  if (first === '') {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (last !== '' && Number(last) < start) return null
  if (start >= size) return 'unsatisfiable'
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) }
}

/**
 * Serves a file from disk with single-range support, ETag and If-Range. The file is
 * opened once, so the headers and the bytes describe the same inode even if it is
 * replaced meanwhile. Returns null when the file does not exist.
 */
export async function serveFile(file: string, mime: string, request: StreamRequest, extraHeaders: Record<string, string> = {}): Promise<StreamResponse | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  try {
    const stats = await handle.stat()
    const size = stats.size
    const etag = `"${size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
    const lastModified = stats.mtime.toUTCString()
    const headers: Record<string, string> = {
      'content-type': mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private',
      etag,
      'last-modified': lastModified,
      ...extraHeaders,
    }
    const rangeApplies = request.ifRange === undefined || request.ifRange === etag || request.ifRange === lastModified
    const range = rangeApplies ? parseRange(request.range, size) : null
    if (range === 'unsatisfiable') {
      await handle.close()
      return { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` }, body: null }
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }
    headers['content-length'] = String(Math.max(0, end - start + 1))
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
    const status = range ? 206 : 200
    if (request.head || size === 0) {
      await handle.close()
      return { status, headers, body: null }
    }
    return { status, headers, body: handle.createReadStream({ start, end }) }
  } catch (error) {
    await handle.close()
    throw error
  }
}
