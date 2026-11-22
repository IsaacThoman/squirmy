import { createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getConfig } from '../../config.js'
import { errorCode } from '../organize/files.js'

/**
 * The staging folder and the file-system steps imports share. Names starting with a dot
 * are the server's own temporary files: walks skip them, so a half-written file is never
 * taken for a real one.
 */

export const TEMP_PREFIX = '.squirmy-'

/** `<data>/staging`, where imports wait until they are processed. */
export function stagingRoot(): string {
  return path.resolve(getConfig().SQUIRMY_DATA_DIR, 'staging')
}

export function stagingDir(importId: string): string {
  return path.join(stagingRoot(), importId)
}

/** Thrown by {@link writeLimited} when a stream passes its byte limit. */
export class TooLargeError extends Error {}

export type WriteCheck = {
  /** Bytes between calls of `check`. */
  everyBytes: number
  /** Called with the bytes written so far; a rejection stops the write with that error. */
  check: (bytes: number) => Promise<void>
}

/**
 * Streams into a new file, failing with {@link TooLargeError} once more than `limit` bytes
 * arrive, or with whatever `periodic.check` throws. The file is created exclusively (`wx`),
 * so an existing file or symbolic link at `file` is never written through. Returns the bytes
 * written; on failure the file is removed.
 */
export async function writeLimited(source: Readable, file: string, limit: number, periodic?: WriteCheck): Promise<number> {
  let bytes = 0
  let nextCheck = periodic?.everyBytes ?? Infinity
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > limit) return callback(new TooLargeError(`More than ${limit} bytes`))
      if (!periodic || bytes < nextCheck) return callback(null, chunk)
      nextCheck = bytes + periodic.everyBytes
      periodic.check(bytes).then(() => callback(null, chunk), callback)
    },
  })
  try {
    await pipeline(source, counter, createWriteStream(file, { flags: 'wx' }))
    return bytes
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
}

export type TreeFile = { relPath: string; absolute: string; size: number }

/**
 * Regular files under `dir` with paths relative to it, in sorted order. Symbolic links,
 * devices and the server's temporary names are skipped and never followed.
 */
export async function* treeFiles(dir: string, relDir = ''): AsyncGenerator<TreeFile> {
  const entries = await readdir(path.join(dir, relDir), { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (entry.name.startsWith(TEMP_PREFIX)) continue
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* treeFiles(dir, relPath)
    else if (entry.isFile()) {
      const absolute = path.join(dir, relPath)
      yield { relPath, absolute, size: (await lstat(absolute)).size }
    }
  }
}

/**
 * Moves a file or folder to `to`, which must not exist: a rename on one file system, else
 * a copy of its regular files and folders (symbolic links are left out) into a temporary
 * sibling of `to`, renamed into place once complete, and then removing the source. So `to`
 * only ever appears whole. `renameFn` is replaceable so tests can force `EXDEV`.
 */
export async function moveTree(from: string, to: string, renameFn: typeof rename = rename): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await renameFn(from, to)
    return
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
  }
  const temp = path.join(path.dirname(to), `${TEMP_PREFIX}copy-${path.basename(to)}`)
  await rm(temp, { recursive: true, force: true })
  await cp(from, temp, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: async (source) => !(await lstat(source)).isSymbolicLink(),
  })
  await rename(temp, to)
  await rm(from, { recursive: true, force: true })
}
