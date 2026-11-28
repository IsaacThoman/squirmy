import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { HygieneFile } from '@squirmy/contracts'
import { and, eq, isNull, not, sql } from 'drizzle-orm'
import { albums, libraryRoots, mediaFiles, recordings } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'

export const collectionFile = and(isNull(mediaFiles.missingSince), not(mediaFiles.cached),
  sql`not starts_with(${mediaFiles.relPath}, '_Incoming/')`)

export const hygieneColumns = {
  file: mediaFiles,
  root: libraryRoots,
  album: albums.title,
  title: recordings.title,
  artist: recordings.artistCredit,
  mbid: recordings.mbid,
}

export type FileRow = {
  file: typeof mediaFiles.$inferSelect
  root: typeof libraryRoots.$inferSelect
  album: string | null
  title: string | null
  artist: string | null
  mbid: string | null
}

export const fileJoins = {
  root: eq(libraryRoots.id, mediaFiles.rootId),
  album: eq(albums.id, mediaFiles.albumId),
  recording: eq(recordings.id, mediaFiles.recordingId),
}

export function revision(file: FileRow['file']) {
  return JSON.stringify([file.rootId, file.relPath, file.size, file.mtime.getTime(), file.audioHash])
}

export function describeFile({ file, root, album, title, artist }: FileRow): HygieneFile {
  const absolute = path.join(root.path, file.relPath)
  return {
    id: file.id, albumId: file.albumId, album, title: file.tags.title ?? title ?? path.basename(file.relPath),
    artist: file.tags.artist ?? artist ?? '', path: absolute, folder: path.dirname(absolute),
    codec: file.codec, container: file.container, lossless: file.lossless, bitrate: file.bitrate,
    bitDepth: file.bitDepth, sampleRate: file.sampleRate, durationMs: file.durationMs,
    managed: root.mode === 'managed' && root.enabled, revision: revision(file),
  }
}

/** Mutations require a regular file at the scanned path, with no symlink components. */
export async function unchangedFile(root: FileRow['root'], file: FileRow['file']) {
  const absolute = path.resolve(root.path, file.relPath)
  const relative = path.relative(root.path, absolute)
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw conflict('The file is outside its library folder', 'file_changed')
  }
  const actual = await realpath(absolute).catch(() => null)
  const info = actual === absolute ? await lstat(absolute).catch(() => null) : null
  if (!info?.isFile() || file.size !== info.size || file.mtime.getTime() !== Math.floor(info.mtimeMs)) {
    throw conflict('The file has changed or is a symbolic link. Scan its folder and try again.', 'file_changed')
  }
  return absolute
}
