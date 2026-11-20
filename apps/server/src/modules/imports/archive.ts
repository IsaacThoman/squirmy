import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ImportFileRejection } from '@squirmy/contracts'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { errorCode } from '../organize/files.js'
import { checkRelativePath } from './paths.js'
import { TooLargeError, writeLimited } from './staging.js'

/**
 * Zip archives in an import. An archive is read in two passes over its central directory
 * with yauzl, which streams each entry from disk and never holds the archive in memory:
 * the first checks every entry without extracting anything, the second extracts.
 *
 * An archive is all or nothing. One unsafe entry (an absolute or `..` path, control
 * characters, a symbolic link, encryption) or a total past the limits rejects the whole
 * archive. Entries that are merely not music (a `.txt`, a nested `.zip`) are skipped and
 * counted, and hidden ones (`__MACOSX/`, `.DS_Store`) are skipped quietly.
 */

export type ArchiveLimits = {
  maxEntries: number
  /** Largest uncompressed entry. */
  maxEntryBytes: number
  /** Largest uncompressed total of the entries that are extracted. */
  maxTotalBytes: number
}

type Planned = { entry: Entry; path: string; bytes: number }

export type ArchivePlan =
  | { ok: true; entries: Planned[]; skipped: number; bytes: number; folder: string }
  | { ok: false; reason: Extract<ImportFileRejection, 'unsafe_archive' | 'unreadable_archive'> }

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
// yauzl's own checks on entry names, which reject the archive before we see the entry.
const unsafeName = /^(absolute path|invalid relative path|invalid characters in fileName)/

const open = (archive: string) => yauzl.openPromise(archive, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false })

/** Entries in central-directory order. Reads only the directory, never file data. */
async function* entries(zip: ZipFile): AsyncGenerator<Entry> {
  for (;;) {
    const next = await new Promise<Entry | null>((resolve, reject) => {
      const cleanup = () => {
        zip.off('entry', onEntry)
        zip.off('end', onEnd)
        zip.off('error', onError)
      }
      const onEntry = (entry: Entry) => { cleanup(); resolve(entry) }
      const onEnd = () => { cleanup(); resolve(null) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      zip.on('entry', onEntry)
      zip.on('end', onEnd)
      zip.on('error', onError)
      zip.readEntry()
    })
    if (!next) return
    yield next
  }
}

const isSymlink = (entry: Entry) => ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK

/**
 * Checks an archive against the path rules and limits without extracting anything.
 * `folder` is the name its contents should get: the single top-level folder every entry
 * shares (which is then dropped from the entry paths), else the archive's own name.
 */
export async function inspectArchive(archive: string, limits: ArchiveLimits): Promise<ArchivePlan> {
  let zip: ZipFile
  try {
    zip = await open(archive)
  } catch {
    return { ok: false, reason: 'unreadable_archive' }
  }
  try {
    if (zip.entryCount > limits.maxEntries) return { ok: false, reason: 'unsafe_archive' }
    const planned: Planned[] = []
    let skipped = 0
    let bytes = 0
    for await (const entry of entries(zip)) {
      if (isSymlink(entry) || entry.isEncrypted()) return { ok: false, reason: 'unsafe_archive' }
      if (entry.fileName.endsWith('/')) continue
      const checked = checkRelativePath(entry.fileName)
      if (!checked.ok) {
        if (checked.reason === 'unsafe_path') return { ok: false, reason: 'unsafe_archive' }
        if (checked.reason !== 'hidden') skipped += 1
        continue
      }
      if (checked.kind === 'archive') {
        skipped += 1
        continue
      }
      bytes += entry.uncompressedSize
      if (entry.uncompressedSize > limits.maxEntryBytes || bytes > limits.maxTotalBytes) return { ok: false, reason: 'unsafe_archive' }
      planned.push({ entry, path: checked.path, bytes: entry.uncompressedSize })
    }
    const tops = new Set(planned.map((item) => item.path.split('/')[0]))
    const shared = tops.size === 1 && planned.every((item) => item.path.includes('/')) ? [...tops][0]! : null
    const folder = shared ?? path.basename(archive, path.extname(archive))
    return {
      ok: true,
      entries: shared ? planned.map((item) => ({ ...item, path: item.path.slice(shared.length + 1) })) : planned,
      skipped,
      bytes,
      folder,
    }
  } catch (error) {
    return { ok: false, reason: unsafeName.test((error as Error).message) ? 'unsafe_archive' : 'unreadable_archive' }
  } finally {
    zip.close()
  }
}

export type ExtractResult = { ok: true; extracted: number; duplicates: number } | { ok: false; reason: 'unsafe_archive' | 'unreadable_archive' }

/**
 * Extracts an inspected archive's entries into `destination`, which must be new. Each
 * entry is written through a byte counter capped at the size the directory declared, and
 * yauzl verifies the size too, so an archive that lies about its sizes (a zip bomb) stops
 * at the declared total. Two entries with one path keep the first.
 */
export async function extractArchive(archive: string, plan: Extract<ArchivePlan, { ok: true }>, destination: string): Promise<ExtractResult> {
  // Entries from the inspection belong to its (closed) handle; match them by position.
  const wanted = new Map(plan.entries.map((item) => [item.entry.relativeOffsetOfLocalHeader, item]))
  let zip: ZipFile
  try {
    zip = await open(archive)
  } catch {
    return { ok: false, reason: 'unreadable_archive' }
  }
  let extracted = 0
  let duplicates = 0
  try {
    await mkdir(destination, { recursive: true })
    for await (const entry of entries(zip)) {
      const item = wanted.get(entry.relativeOffsetOfLocalHeader)
      if (!item) continue
      const target = path.join(destination, item.path)
      try {
        await mkdir(path.dirname(target), { recursive: true })
        await writeLimited(await zip.openReadStreamPromise(entry), target, item.bytes)
        extracted += 1
      } catch (error) {
        // Another entry already holds the path, as a file or a folder.
        if (!['EEXIST', 'ENOTDIR'].includes(errorCode(error) ?? '')) throw error
        duplicates += 1
      }
    }
    return { ok: true, extracted, duplicates }
  } catch (error) {
    if (error instanceof TooLargeError || /too (many|few) bytes/.test((error as Error).message)) return { ok: false, reason: 'unsafe_archive' }
    // Damaged data: yauzl's errors carry no code and zlib's start with Z_. Anything else
    // (a full disk) is the server's problem and is retried.
    const code = errorCode(error)
    if (code === undefined || code.startsWith('Z_')) return { ok: false, reason: 'unreadable_archive' }
    throw error
  } finally {
    zip.close()
  }
}
