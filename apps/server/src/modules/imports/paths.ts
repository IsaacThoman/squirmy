import path from 'node:path'
import type { ImportFileRejection } from '@squirmy/contracts'
import { isAudioFile, isSkipped } from '../library/walk.js'

/**
 * What an import accepts, decided by name alone: audio by the scanner's extension list,
 * the sidecars that travel with an album, and zip archives. Paths come from clients and
 * archives, so they are checked before anything touches the disk.
 */

/** Deepest path inside an import, counting the file name. */
const MAX_DEPTH = 8
/** Longest path inside an import, in UTF-8 bytes. */
const MAX_PATH_BYTES = 1024
/** Longest single name, in UTF-8 bytes; most file systems allow 255. */
const MAX_NAME_BYTES = 255

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])
const sidecarExtensions = new Set(['lrc', 'cue', 'log'])
// Resource forks macOS adds to archives it makes.
const systemFolders = new Set(['__MACOSX'])
const isControl = (character: string) => {
  const code = character.codePointAt(0)!
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

export type FileKind = 'audio' | 'sidecar' | 'archive'

const extensionOf = (name: string) => path.posix.extname(name).slice(1).toLowerCase()

/** What a file is by its name, or null when imports do not take it. */
export function fileKind(name: string): FileKind | null {
  const extension = extensionOf(name)
  if (isAudioFile(name)) return 'audio'
  if (extension === 'zip') return 'archive'
  if (sidecarExtensions.has(extension)) return 'sidecar'
  const stem = path.posix.basename(name, path.posix.extname(name)).toLowerCase()
  if ((stem === 'cover' || stem === 'folder') && imageExtensions.has(extension)) return 'sidecar'
  return null
}

export type CheckedPath = { ok: true; path: string; kind: FileKind } | { ok: false; reason: ImportFileRejection }

/**
 * Normalizes a client- or archive-supplied relative path (backslashes become slashes,
 * empty and `.` segments are dropped, Unicode is NFC) and decides whether an import takes
 * it. Absolute paths, drive letters, `..`, control characters, and paths deeper than
 * {@link MAX_DEPTH} or longer than {@link MAX_PATH_BYTES} are unsafe. Hidden and system
 * entries (`.DS_Store`, `__MACOSX/`, `@eaDir/`) are `hidden`.
 */
export function checkRelativePath(raw: string): CheckedPath {
  const text = raw.normalize('NFC')
  if ([...text].some(isControl)) return { ok: false, reason: 'unsafe_path' }
  const slashed = text.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return { ok: false, reason: 'unsafe_path' }
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return { ok: false, reason: 'unsafe_path' }
  const joined = segments.join('/')
  if (segments.length > MAX_DEPTH || Buffer.byteLength(joined) > MAX_PATH_BYTES) return { ok: false, reason: 'unsafe_path' }
  if (segments.some((segment) => Buffer.byteLength(segment) > MAX_NAME_BYTES)) return { ok: false, reason: 'unsafe_path' }
  if (segments.some((segment) => isSkipped(segment) || systemFolders.has(segment))) return { ok: false, reason: 'hidden' }
  const kind = fileKind(segments[segments.length - 1]!)
  return kind ? { ok: true, path: joined, kind } : { ok: false, reason: 'unsupported_type' }
}

/** The n-th candidate for a name that may be taken: "Album", then "Album (2)", "Album (3)"… */
export function numbered(name: string, n: number): string {
  return n === 1 ? name : `${name} (${n})`
}
