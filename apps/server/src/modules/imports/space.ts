import { statfs } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '../../lib/errors.js'
import { errorCode } from '../organize/files.js'

/**
 * Free disk space for imports. Staging usually shares a disk with the database and the
 * server's other data, so an upload or an extraction that would leave less than this free
 * is refused rather than started: a full disk stops everything, not only the import.
 */
export const MIN_FREE_BYTES = 1024 ** 3

/** Replaceable so tests can pretend the disk is nearly full. */
export const disk = {
  /** Bytes an unprivileged process may still write on the file system holding `directory`. */
  async freeBytes(directory: string): Promise<number> {
    // A folder that is not made yet is on its nearest existing parent's file system.
    for (let at = path.resolve(directory); ; at = path.dirname(at)) {
      try {
        const stats = await statfs(at)
        return stats.bavail * stats.bsize
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' || at === path.dirname(at)) throw error
      }
    }
  },
  /** How often a file of unknown length is checked again while it arrives. */
  checkEveryBytes: 256 * 1024 ** 2,
}

export const insufficientStorage = () =>
  new AppError(507, 'insufficient_storage', 'The server is running out of disk space and cannot take this now', { minFreeBytes: MIN_FREE_BYTES })

/** Whether `incomingBytes` more still leaves MIN_FREE_BYTES free where `directory` is. */
export async function hasRoomFor(directory: string, incomingBytes: number): Promise<boolean> {
  return await disk.freeBytes(directory) - incomingBytes >= MIN_FREE_BYTES
}

/** Throws 507 `insufficient_storage` unless {@link hasRoomFor}. */
export async function requireRoomFor(directory: string, incomingBytes: number): Promise<void> {
  if (!(await hasRoomFor(directory, incomingBytes))) throw insufficientStorage()
}
