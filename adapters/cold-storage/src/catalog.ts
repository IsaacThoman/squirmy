/**
 * The cold-storage index: every audio file under a folder with the tags that identify it,
 * and the rules that match a request to a file.
 *
 * A recording is matched, most specific first, by:
 * 1. its MusicBrainz recording id (`MUSICBRAINZ_TRACKID` and friends);
 * 2. one of its ISRCs;
 * 3. artist and title (compared without case, accents, punctuation or edition suffixes
 *    such as "(Remastered 2009)"; "Artist feat. Other" matches "Artist") with a length
 *    within {@link DURATION_TOLERANCE_MS}. Without a
 *    requested length, the album title must match too, or the match must be the only one.
 *
 * An album is matched by its MusicBrainz release group id, else by album artist and title.
 * Among several matching files the closest length wins, then lossless, then the higher bitrate.
 */
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderAlbumQuery, ProviderRecordingQuery } from '@squirmy/contracts'
import { textKey, titleKey } from '@squirmy/provider-kit'
import { parseFile } from 'music-metadata'

export const DURATION_TOLERANCE_MS = 3000
const audioExtensions = new Set(['.flac', '.mp3', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff', '.wv', '.ape', '.alac'])

export type ColdFile = {
  /** Stable for a path: the offer id is derived from it. */
  id: string
  path: string
  /** Path inside the folder, with forward slashes. */
  relPath: string
  size: number
  mtimeMs: number
  title: string
  artist: string
  albumArtist: string
  album: string | null
  recordingMbid: string | null
  releaseGroupMbid: string | null
  isrcs: string[]
  disc: number
  track: number | null
  durationMs: number | null
  format: string
  lossless: boolean
  sampleRate: number | null
  bitDepth: number | null
  bitrate: number | null
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24)
const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || null
/** One credit is the other with more names after it. */
const sameArtist = (a: string, b: string) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)

/** The key an album's files share: release group id, else album artist and title. */
export function albumKey(file: Pick<ColdFile, 'releaseGroupMbid' | 'albumArtist' | 'album'>): string | null {
  if (file.releaseGroupMbid) return `mbid:${file.releaseGroupMbid}`
  return file.album ? `name:${textKey(file.albumArtist)}|${titleKey(file.album)}` : null
}

/** A short stable id for the album a file is on, used in offer ids. Null for a file without an album. */
export function albumId(file: Pick<ColdFile, 'releaseGroupMbid' | 'albumArtist' | 'album'>): string | null {
  const key = albumKey(file)
  return key ? hash(key) : null
}

/** Reads one file's tags. Null for files nothing can read. */
async function readFile(absolute: string, relPath: string, size: number, mtimeMs: number): Promise<ColdFile | null> {
  try {
    const { common, format } = await parseFile(absolute, { duration: true, skipCovers: true })
    const artist = common.artist ?? common.albumartist ?? ''
    const title = common.title ?? path.basename(relPath, path.extname(relPath))
    return {
      id: hash(relPath), path: absolute, relPath, size, mtimeMs,
      title, artist, albumArtist: common.albumartist ?? artist, album: common.album ?? null,
      recordingMbid: lower(common.musicbrainz_recordingid), releaseGroupMbid: lower(common.musicbrainz_releasegroupid),
      isrcs: (common.isrc ?? []).map((isrc) => isrc.trim().toUpperCase()),
      disc: common.disk.no ?? 1, track: common.track.no ?? null,
      durationMs: format.duration ? Math.round(format.duration * 1000) : null,
      format: path.extname(relPath).slice(1).toLowerCase(), lossless: format.lossless ?? false,
      sampleRate: format.sampleRate ?? null, bitDepth: format.bitsPerSample ?? null,
      bitrate: format.bitrate ? Math.round(format.bitrate) : null,
    }
  } catch {
    return null
  }
}

async function* walk(root: string, relDir = ''): AsyncGenerator<{ absolute: string; relPath: string }> {
  const entries = await readdir(path.join(root, relDir), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(root, relPath)
    else if (entry.isFile() && audioExtensions.has(path.extname(entry.name).toLowerCase())) yield { absolute: path.join(root, relPath), relPath }
  }
}

export class ColdIndex {
  private files = new Map<string, ColdFile>()

  constructor(readonly root: string) {}

  /** Every indexed file. */
  all(): ColdFile[] {
    return [...this.files.values()]
  }

  byId(id: string): ColdFile | undefined {
    return this.files.get(id)
  }

  /**
   * Walks the folder, reading tags of new and changed files and forgetting vanished ones.
   * Unchanged files (same size and modification time) are not read again.
   */
  async scan(): Promise<{ files: number; read: number }> {
    const seen = new Set<string>()
    let read = 0
    for await (const { absolute, relPath } of walk(this.root)) {
      const info = await stat(absolute).catch(() => null)
      if (!info) continue
      const id = hash(relPath)
      seen.add(id)
      const known = this.files.get(id)
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue
      const file = await readFile(absolute, relPath, info.size, info.mtimeMs)
      read += 1
      if (file) this.files.set(id, file)
      else this.files.delete(id)
    }
    for (const id of this.files.keys()) if (!seen.has(id)) this.files.delete(id)
    return { files: this.files.size, read }
  }

  /** The file that is this recording, by the rules at the top of this file. */
  matchRecording(query: ProviderRecordingQuery): ColdFile | null {
    const files = this.all()
    const mbid = lower(query.mbid)
    if (mbid) {
      const found = best(files.filter((file) => file.recordingMbid === mbid), query.durationMs)
      if (found) return found
    }
    const isrcs = new Set(query.isrcs.map((isrc) => isrc.trim().toUpperCase()))
    if (isrcs.size > 0) {
      const found = best(files.filter((file) => file.isrcs.some((isrc) => isrcs.has(isrc))), query.durationMs)
      if (found) return found
    }
    const title = titleKey(query.title)
    const artist = textKey(query.artist)
    if (!title || !artist) return null
    const named = files.filter((file) => titleKey(file.title) === title && sameArtist(textKey(file.artist), artist))
    if (query.durationMs !== null) {
      return best(named.filter((file) => file.durationMs !== null && Math.abs(file.durationMs - query.durationMs!) <= DURATION_TOLERANCE_MS), query.durationMs)
    }
    const album = query.album ? titleKey(query.album.title) : null
    const onAlbum = album ? named.filter((file) => file.album !== null && titleKey(file.album) === album) : []
    if (onAlbum.length > 0) return best(onAlbum, null)
    return named.length === 1 ? named[0]! : null
  }

  /** The files of an album, in disc and track order. Empty when it is not here. */
  matchAlbum(query: ProviderAlbumQuery): ColdFile[] {
    const files = this.all()
    const mbid = lower(query.mbid)
    let found = mbid ? files.filter((file) => file.releaseGroupMbid === mbid) : []
    if (found.length === 0) {
      const key = `name:${textKey(query.artist)}|${titleKey(query.title)}`
      found = files.filter((file) => albumKey({ ...file, releaseGroupMbid: null }) === key)
    }
    return found.sort((a, b) => a.disc - b.disc || (a.track ?? 0) - (b.track ?? 0) || a.relPath.localeCompare(b.relPath))
  }

  /** The files of the album with this {@link albumId}, in the order `matchAlbum` gives. */
  albumFiles(id: string): ColdFile[] {
    return this.all().filter((file) => albumId(file) === id)
      .sort((a, b) => a.disc - b.disc || (a.track ?? 0) - (b.track ?? 0) || a.relPath.localeCompare(b.relPath))
  }
}

/** Closest length first, then lossless, then the higher bitrate. */
function best(files: ColdFile[], durationMs: number | null): ColdFile | null {
  const distance = (file: ColdFile) => durationMs === null || file.durationMs === null ? 0 : Math.abs(file.durationMs - durationMs)
  return [...files].sort((a, b) => distance(a) - distance(b) || Number(b.lossless) - Number(a.lossless) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null
}
