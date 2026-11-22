import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const audioExtensions = new Set(['mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aiff', 'aif', 'wv', 'ape', 'wma', 'dsf'])

// NAS metadata folders and recycle bins.
const skippedNames = new Set(['@eaDir', '#recycle', '#snapshot', '$RECYCLE.BIN', 'System Volume Information', 'lost+found'])
// Downloads in progress, for clients that write under a temporary name.
const partialName = /\.(part|partial|crdownload|download|tmp|!qb|!ut|aria2)$/i

/** Hidden entries, NAS metadata folders and partial downloads are never scanned. */
export function isSkipped(name: string): boolean {
  return name.startsWith('.') || skippedNames.has(name) || partialName.test(name)
}

export function isAudioFile(name: string): boolean {
  return audioExtensions.has(path.extname(name).slice(1).toLowerCase())
}

/** True when a root-relative path passes through a skipped folder or names a skipped file. */
export function isSkippedPath(relPath: string): boolean {
  return relPath.split('/').some(isSkipped)
}

/** Orders paths the way Postgres's "C" collation does: by UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

export type WalkEntry = { relPath: string; size: number; mtime: Date }

export type WalkOptions = {
  /** Real path of the library root. Nothing outside it is followed. */
  root: string
  /** Called for folders and files that cannot be read; the walk continues. */
  onError: (relPath: string, error: unknown) => void
}

const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

/**
 * Yields the audio files under `start` (a root-relative path, '' for the whole root) in
 * byte order of their relative paths, so the walk can be merged with rows read in the
 * same order. Memory holds one directory listing per level, never the whole tree.
 *
 * Symbolic links are followed only to files inside the root; linked folders are skipped,
 * which also rules out loops. The same holds for `start` itself.
 */
export async function* walk(start: string, options: WalkOptions): AsyncGenerator<WalkEntry> {
  const absolute = path.join(options.root, start)
  if (start) {
    // A scope (from the watcher, say) gets the rule the full walk applies to its entries: a
    // link only to an audio file, and nothing whose real path, through a linked parent
    // folder too, is outside the root.
    const own = await lstat(absolute).catch(() => null)
    if (!own || (own.isSymbolicLink() && !isAudioFile(start)) || !(await linksInside(absolute, options.root))) return
  }
  const info = await stat(absolute).catch(() => null)
  if (!info) return
  if (info.isDirectory()) yield* walkDirectory(start, options)
  else if (info.isFile() && isAudioFile(start) && !isSkippedPath(start)) yield { relPath: start, size: info.size, mtime: wholeMilliseconds(info.mtimeMs) }
}

// Postgres keeps microseconds and JavaScript dates milliseconds; compare in milliseconds.
const wholeMilliseconds = (ms: number) => new Date(Math.floor(ms))

async function* walkDirectory(relDir: string, options: WalkOptions): AsyncGenerator<WalkEntry> {
  let entries: Dirent[]
  try {
    entries = await readdir(path.join(options.root, relDir), { withFileTypes: true })
  } catch (error) {
    options.onError(relDir, error)
    return
  }
  const items: { name: string; directory: boolean; sortKey: Buffer }[] = []
  for (const entry of entries) {
    if (isSkipped(entry.name)) continue
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      if (!isAudioFile(entry.name) || !(await linksInside(path.join(options.root, relDir, entry.name), options.root))) continue
      directory = false
    } else if (!directory && !(entry.isFile() && isAudioFile(entry.name))) {
      continue
    }
    // A trailing slash makes folder order match the byte order of the full paths inside it.
    items.push({ name: entry.name, directory, sortKey: Buffer.from(directory ? `${entry.name}/` : entry.name) })
  }
  items.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey))

  // Stat a folder's files concurrently, then yield them in order.
  const files = items.filter((item) => !item.directory)
  const stats = new Map<string, { size: number; mtime: Date } | null>()
  for (let index = 0; index < files.length; index += 32) {
    await Promise.all(files.slice(index, index + 32).map(async (item) => {
      const relPath = join(relDir, item.name)
      const info = await stat(path.join(options.root, relPath)).catch((error: unknown) => {
        options.onError(relPath, error)
        return null
      })
      stats.set(item.name, info?.isFile() ? { size: info.size, mtime: wholeMilliseconds(info.mtimeMs) } : null)
    }))
  }

  for (const item of items) {
    const relPath = join(relDir, item.name)
    if (item.directory) {
      yield* walkDirectory(relPath, options)
      continue
    }
    const info = stats.get(item.name)
    if (info) yield { relPath, ...info }
  }
}

async function linksInside(link: string, root: string): Promise<boolean> {
  const target = await realpath(link).catch(() => null)
  if (!target) return false
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
