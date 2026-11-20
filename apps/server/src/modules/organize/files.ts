import { createHash } from 'node:crypto'
import { createReadStream, constants, type Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { foldPath } from './template.js'

/**
 * File-system steps for organizing. Every function here is safe to run again after a
 * crash at any point: it looks at what is on disk and finishes the job, and it never
 * replaces a file that is already at the destination.
 */

/** The calls that move bytes. Tests replace them to force `EXDEV` or a bad copy. */
export type FileOps = {
  link: (from: string, to: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  copyFile: (from: string, to: string, mode: number) => Promise<void>
}

export const realFileOps: FileOps = { link: fsp.link, rename: fsp.rename, copyFile: fsp.copyFile }

/** A step that could not be done safely. The message is shown to the admin. */
export class MoveError extends Error {}

// link() is how a move avoids replacing a file that appears at the last moment. Some
// file systems (SMB, FAT, some FUSE mounts) do not support hard links.
const linkUnsupported = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'])

export const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

export async function lstatOrNull(file: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(file)
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
    throw error
  }
}

export async function removeIfExists(file: string) {
  await fsp.rm(file, { force: true })
}

/** SHA-256 of a file's bytes, hex. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Flushes a file or directory to disk. Some file systems cannot fsync a directory; that is not an error. */
export async function fsyncPath(target: string) {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(target, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EBADF'].includes(errorCode(error) ?? '')) throw error
  } finally {
    await handle?.close()
  }
}

/** True when both paths are the same file (inode), for example two spellings on a case-insensitive file system. */
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

/** True when the directory lists exactly this name, as opposed to a different-case spelling of it. */
async function listsExactly(file: string): Promise<boolean> {
  const name = path.basename(file).normalize('NFC')
  return (await fsp.readdir(path.dirname(file))).some((entry) => entry.normalize('NFC') === name)
}

/** Places `from` at `to` within one file system without ever replacing an existing `to`. */
async function placeWithoutReplacing(from: string, to: string, ops: FileOps) {
  try {
    await ops.link(from, to)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') throw new MoveError('Something already exists at the destination; nothing was overwritten')
    if (!linkUnsupported.has(code ?? '')) throw error
    // Without hard links, check-then-rename is the best available. The root lock keeps
    // Squirmy itself out of the gap; only an outside writer could race it.
    if (await lstatOrNull(to)) throw new MoveError('Something already exists at the destination; nothing was overwritten')
    await ops.rename(from, to)
    return
  }
  await fsp.unlink(from)
}

/**
 * Copies across file systems: copy to `temp` beside the destination, fsync, compare
 * size and SHA-256 with the source, move into place, then delete the source.
 */
async function copyAcross(from: string, to: string, temp: string, ops: FileOps) {
  const source = await fsp.stat(from)
  await ops.copyFile(from, temp, constants.COPYFILE_EXCL)
  try {
    await fsp.utimes(temp, source.atime, source.mtime)
    await fsyncPath(temp)
    const copy = await fsp.stat(temp)
    if (copy.size !== source.size || await sha256File(temp) !== await sha256File(from)) {
      throw new MoveError('The copy did not match the original; the original was left in place')
    }
    await placeWithoutReplacing(temp, to, ops)
  } catch (error) {
    await removeIfExists(temp)
    throw error
  }
  await fsyncPath(path.dirname(to))
  await fsp.unlink(from)
}

export type MoveOptions = {
  /** A name in the destination directory reserved for this move's cross-device copy. */
  temp: string
  ops: FileOps
  /** Creates the destination's directory (and records what it created). */
  ensureDirectory: (directory: string) => Promise<void>
  /**
   * Called when the source is gone and the destination exists, which is what a move
   * interrupted after its file-system step looks like. Returns whether the file at
   * the destination is the one being moved.
   */
  isMovedFile: (to: string, stats: Stats) => Promise<boolean>
}

/**
 * Moves one file and returns once `to` holds it and `from` is gone. Run again after a
 * crash, it recognizes and finishes every intermediate state:
 * - a stale temp copy is deleted and the copy starts over;
 * - a hard link left before the source was unlinked is completed;
 * - a finished cross-device copy whose source was not yet deleted is verified byte for
 *   byte, then the source is deleted;
 * - a move that already happened is confirmed with `isMovedFile`.
 * Anything else at the destination is left alone and reported.
 */
export async function moveFile(from: string, to: string, options: MoveOptions): Promise<void> {
  await removeIfExists(options.temp)
  const source = await lstatOrNull(from)
  const target = await lstatOrNull(to)

  if (!source) {
    if (target && await options.isMovedFile(to, target)) return
    throw new MoveError(target ? 'The file is gone and something else is at the destination' : 'The file is no longer there')
  }
  if (!source.isFile()) throw new MoveError('Not a regular file')

  if (target) {
    if (sameInode(source, target)) {
      if (foldPath(from) !== foldPath(to) || (await listsExactly(from) && await listsExactly(to))) {
        // Two hard links to one file: the move stopped between link() and unlink().
        await fsp.unlink(from)
      } else if (!await listsExactly(to)) {
        // A case-only rename on a case-insensitive file system: both names are one entry.
        await options.ops.rename(from, to)
      }
      return
    }
    if (target.isFile() && target.size === source.size && await sha256File(to) === await sha256File(from)) {
      // An identical copy is already in place, as a cross-device move leaves it when it
      // stops before deleting the source. Nothing is lost by deleting the source.
      await fsp.unlink(from)
      return
    }
    throw new MoveError('Something already exists at the destination; nothing was overwritten')
  }

  await options.ensureDirectory(path.dirname(to))
  try {
    await placeWithoutReplacing(from, to, options.ops)
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
    await copyAcross(from, to, options.temp, options.ops)
  }
}

/** Removes a directory if it is empty. Returns whether it was removed. */
export async function removeEmptyDirectory(directory: string): Promise<boolean> {
  try {
    await fsp.rmdir(directory)
    return true
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return false
    throw error
  }
}

/** Lists a directory, or returns an empty list when it does not exist. */
export async function readdirOrEmpty(directory: string) {
  try {
    return await fsp.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return []
    throw error
  }
}
