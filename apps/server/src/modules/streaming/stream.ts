import path from 'node:path'
import type { StreamProfile } from '@squirmy/contracts'
import { serveFile, withLibraryFile, type StreamRequest, type StreamResponse } from './files.js'
import { mimeFor, profiles, type MediaFile } from './profiles.js'
import { openTranscode } from './transcode.js'

export type { StreamRequest, StreamResponse } from './files.js'

/** "Artist - Title.ext" from the tags, else the file's own name, safe on every OS. */
export function downloadName(file: Pick<MediaFile, 'relPath' | 'tags'>, profile: StreamProfile): string {
  const extension = profile === 'original' ? path.extname(file.relPath) : `.${profiles[profile].extension}`
  const { artist, title } = file.tags
  const base = title ? (artist ? `${artist} - ${title}` : title) : path.basename(file.relPath, path.extname(file.relPath))
  // Control characters and characters some filesystems forbid.
  // oxlint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 200)
  return `${clean || 'track'}${extension}`
}

function attachment(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%]/g, '_')
  return `attachment; filename="${ascii || 'track'}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Opens `file` for streaming as `profile`. Originals and cached transcodes honour Range,
 * If-Range and HEAD; a transcode that is not cached yet streams as it is encoded. With
 * `download` the response is marked as an attachment. A file organize is moving is found at
 * either end of the move. Throws 404 `file_missing` (and marks the file missing) when it is
 * gone from disk.
 */
export async function openStream(file: MediaFile, profile: StreamProfile, request: StreamRequest & { download?: boolean } = {}): Promise<StreamResponse> {
  const headers: Record<string, string> = request.download ? { 'content-disposition': attachment(downloadName(file, profile)) } : {}
  if (profile !== 'original') return openTranscode(file, profile, request, headers)
  return withLibraryFile(file, (absolutePath) => serveFile(absolutePath, mimeFor(file), request, headers))
}
