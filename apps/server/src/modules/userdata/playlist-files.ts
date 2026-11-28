import { posix } from 'node:path'
import { PLAYLIST_ITEM_LIMIT, PLAYLIST_NAME_MAX_LENGTH, PlaylistFolderRequest, type PlaylistExportFormat, type PlaylistImportResult } from '@squirmy/contracts'
import { parse } from 'csv-parse/sync'
import { sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { SaxesParser } from 'saxes'
import { db } from '../../database/client.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { uuidArray } from '../catalog/sql.js'
import { textArray } from '../search/keys.js'
import { createPlaylist, getPlaylist, playlistFull } from './playlists.js'

export async function readPlaylistFile(request: FastifyRequest, limit: number) {
  if (!request.isMultipart()) throw badRequest('Choose one file', 'invalid_playlist_upload')
  let file: { name: string; bytes: Buffer } | undefined
  try {
    for await (const part of request.parts({ limits: { fileSize: limit + 1, files: 1, fields: 0, parts: 2 } })) {
      if (part.type !== 'file' || part.fieldname !== 'file') throw badRequest('Choose one file', 'invalid_playlist_upload')
      const bytes = await part.toBuffer()
      if (bytes.length > limit) throw new AppError(413, 'playlist_file_too_large', 'This file is too large')
      file = { name: part.filename, bytes }
    }
  } catch (error) {
    if (error instanceof request.server.multipartErrors.RequestFileTooLargeError) {
      throw new AppError(413, 'playlist_file_too_large', 'This file is too large')
    }
    throw error
  }
  if (!file?.bytes.length) throw badRequest('Choose a non-empty file', 'invalid_playlist_upload')
  return file
}

type Entry = { line: number; text: string; artist?: string; title?: string; album?: string; paths?: string[] }

const invalidFile = () => badRequest('This playlist file could not be read', 'invalid_playlist_file')

function fromLabel(label: string) {
  const split = /\s+[–—-]\s+/.exec(label)
  if (!split) return {}
  return { artist: label.slice(0, split.index), title: label.slice(split.index + split[0].length) }
}

function lineEntries(text: string, m3u: boolean): Entry[] {
  let label = ''
  const entries: Entry[] = []
  const lines = text.split(/\r\n?|\n/)
  for (const [index, line] of lines.entries()) {
    const value = line.trim()
    if (!value) continue
    const number = index + 1
    if (m3u && value.startsWith('#')) {
      if (/^#EXTINF:[^,]*,/i.test(value)) label = value.slice(value.indexOf(',') + 1).trim()
      if (!/^#SQUIRMY-MISSING:/i.test(value)) continue
      const missing = label || value.slice(value.indexOf(':') + 1).trim()
      entries.push({ line: number, text: missing, ...fromLabel(missing) })
    } else if (m3u) entries.push({ line: number, text: label || value, paths: [value], ...fromLabel(label) })
    else entries.push({ line: number, text: value, ...fromLabel(value) })
    label = ''
    if (entries.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
  }
  return entries
}

function csvEntries(text: string): Entry[] {
  let rows: { record: string[]; info: { lines: number } }[]
  try {
    // The sync overload types only the bare record, even when info wraps it.
    rows = parse(text, { bom: true, skip_empty_lines: true, info: true, to: PLAYLIST_ITEM_LIMIT + 2 }) as unknown as typeof rows
  } catch {
    throw invalidFile()
  }
  const header = rows.shift()?.record.map(matchKey) ?? []
  const titleColumn = header.indexOf('track name')
  const artistColumn = header.indexOf('artist name s')
  const albumColumn = header.indexOf('album name')
  if (titleColumn < 0 || artistColumn < 0) throw invalidFile()
  return rows.map(({ record, info }) => {
    const title = record[titleColumn]
    const artist = record[artistColumn]
    return { line: info.lines, text: [artist, title].filter(Boolean).join(' - ') || '(empty track)', title, artist, album: record[albumColumn] }
  })
}

function xspfEntries(text: string): Entry[] {
  const parser = new SaxesParser({ xmlns: true })
  const entries: Entry[] = []
  const ns = 'http://xspf.org/ns/0/'
  const path: string[] = []
  let current: Entry | undefined
  let value = ''
  let validRoot = false
  parser.on('doctype', () => { throw invalidFile() })
  parser.on('opentag', (tag) => {
    path.push(tag.uri === ns || tag.uri === '' ? tag.local : '')
    if (path.length === 1) validRoot = path[0] === 'playlist'
    if (validRoot && path.length === 3 && path[1] === 'trackList' && path[2] === 'track') current = { line: parser.line, text: '', paths: [] }
    if (current && path.length === 4) value = ''
  })
  const append = (chunk: string) => { if (current && path.length === 4) value += chunk }
  parser.on('text', append)
  parser.on('cdata', append)
  parser.on('closetag', () => {
    const field = path.pop()
    if (!current) return
    if (path.length === 3) {
      const text = value.trim()
      if (field === 'title') current.title = text
      if (field === 'creator') current.artist = text
      if (field === 'album') current.album = text
      if (field === 'location' && text) {
        // XSPF locations are URI references. Only a relative URI needs decoding here.
        try {
          const location = /^[a-z][\w+.-]*:/i.test(text) ? text : decodeURIComponent(text)
          current.paths!.push(location)
        } catch {
          // Another location or the metadata can still identify the track.
        }
      }
    }
    if (path.length === 2 && field === 'track') {
      current.text = [current.artist, current.title].filter(Boolean).join(' - ') || current.paths?.[0] || '(empty track)'
      entries.push(current)
      if (entries.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
      current = undefined
    }
  })
  try {
    parser.write(text).close()
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidFile()
  }
  if (!validRoot) throw invalidFile()
  return entries
}

/** Location strings are matched against indexed paths, never used to read a file or fetch a URL. */
function libraryPath(value: string): string | null {
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.hostname) return null
      value = decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  } else if (/^[a-z][\w+.-]+:/i.test(value)) return null
  return posix.normalize(value.replaceAll('\\', '/'))
}

type Candidate = { trackId: string; albumId: string | null; key: string; relPath: string; absolute: string; albumKey: string | null; owned: boolean }

async function matchEntries(entries: Entry[]) {
  const keyFor = (entry: Entry) => entry.artist && entry.title ? creditKey(entry.artist, entry.title) : ''
  const pathsFor = (entry: Entry) => (entry.paths ?? []).flatMap((path) => libraryPath(path) ?? [])
  const keys = [...new Set(entries.map(keyFor).filter((key) => key && !key.startsWith('|') && !key.endsWith('|')))]
  const paths = [...new Set(entries.flatMap(pathsFor))]
  const relative = paths.filter((path) => !path.startsWith('/'))
  const absolute = paths.filter((path) => path.startsWith('/'))
  const pathRows = paths.length ? await db.execute<Candidate>(sql`
    select r.id as "trackId", f.album_id as "albumId", r.match_key as key, f.rel_path as "relPath",
      rtrim(root.path, '/') || '/' || f.rel_path as absolute, a.title_key as "albumKey", true as owned
    from media_files f join library_roots root on root.id = f.root_id join recordings r on r.id = f.recording_id
    left join albums a on a.id = f.album_id
    where not f.cached and f.missing_since is null and r.merged_into_id is null and
      (f.rel_path in (select unnest(${textArray(relative)}))
       or rtrim(root.path, '/') || '/' || f.rel_path in (select unnest(${textArray(absolute)})))
    order by r.id, f.id`) : []
  const nameRows = keys.length ? await db.execute<Candidate>(sql`
    select r.id as "trackId", coalesce(placement.album_id, r.album_hint_id) as "albumId",
      r.match_key as key, a.title_key as "albumKey", coalesce(placement.owned, false) as owned
    from recordings r
    left join lateral (
      select distinct f.album_id, true as owned from media_files f
      where f.recording_id = r.id and f.missing_since is null and not f.cached
      union
      select distinct rel.album_id, false as owned from release_tracks rt join releases rel on rel.id = rt.release_id
      where rt.recording_id = r.id
    ) placement on true
    left join albums a on a.id = coalesce(placement.album_id, r.album_hint_id)
    where r.merged_into_id is null and r.match_key in (select unnest(${textArray(keys)}))
    order by r.id, placement.album_id`) : []
  const byPath = new Map<string, Candidate[]>()
  for (const row of pathRows) {
    for (const path of [row.relPath, row.absolute]) {
      const candidates = byPath.get(path) ?? []
      candidates.push(row)
      byPath.set(path, candidates)
    }
  }
  const byKey = new Map<string, Candidate[]>()
  for (const row of nameRows) {
    const candidates = byKey.get(row.key) ?? []
    candidates.push(row)
    byKey.set(row.key, candidates)
  }
  const tracks: { trackId: string; albumId: string | null }[] = []
  const unmatched: PlaylistImportResult['unmatched'] = []
  for (const entry of entries) {
    const key = keyFor(entry)
    const albumKey = entry.album ? matchKey(entry.album) : null
    const pathMatches = pathsFor(entry).flatMap((path) => byPath.get(path) ?? [])
    const pathCandidates = key ? pathMatches.filter((row) => row.key === key) : pathMatches
    const candidates = pathCandidates.length ? pathCandidates : byKey.get(key) ?? []
    let best: Candidate | undefined
    let bestScore = -1
    let tied = false
    for (const candidate of candidates) {
      const score = Number(candidate.owned) + (albumKey && candidate.albumKey === albumKey ? 2 : 0)
      if (score > bestScore) {
        best = candidate
        bestScore = score
        tied = false
      } else if (score === bestScore && best?.trackId !== candidate.trackId) tied = true
    }
    if (best && !tied) tracks.push({ trackId: best.trackId, albumId: best.albumId })
    else unmatched.push({ line: entry.line, text: entry.text.slice(0, 500) })
  }
  return { tracks, unmatched }
}

export async function importPlaylist(userId: string, name: string, bytes: Uint8Array): Promise<PlaylistImportResult> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw badRequest('Save the playlist as UTF-8 and try again', 'invalid_playlist_encoding')
  }
  const extension = posix.extname(name).toLowerCase()
  const entries = extension === '.xspf' ? xspfEntries(text)
    : extension === '.csv' ? csvEntries(text)
    : lineEntries(text, extension === '.m3u' || extension === '.m3u8' || /^\s*#EXTM3U/i.test(text))
  if (entries.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
  if (!entries.length) throw badRequest('This file has no songs', 'empty_playlist_file')
  const { tracks, unmatched } = await matchEntries(entries)
  const rawName = posix.basename(name, posix.extname(name)).trim()
  const { name: playlistName } = PlaylistFolderRequest.parse({ name: rawName.slice(0, PLAYLIST_NAME_MAX_LENGTH) || 'Imported playlist' })
  const playlist = await createPlaylist(userId, { name: playlistName }, tracks)
  return { playlist, matched: tracks.length, unmatched }
}

const oneLine = (text: string) => text.replace(/[\r\n]/g, ' ')
// XML 1.0 forbids most control characters, including in text nodes.
// eslint-disable-next-line no-control-regex
const xml = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export async function exportPlaylist(userId: string, id: string, format: PlaylistExportFormat): Promise<string> {
  const playlist = await getPlaylist(userId, id)
  const refs = playlist.items.map(({ track }) => ({ id: track.id, albumId: track.album?.id ?? null }))
  const files = refs.length ? await db.execute<{ index: number; path: string }>(sql`
    select wanted.ordinality::int - 1 as index, best.rel_path as path
    from unnest(${uuidArray(refs.map((ref) => ref.id))}, ${uuidArray(refs.map((ref) => ref.albumId))})
      with ordinality as wanted(id, album_id, ordinality)
    cross join lateral (
      select f.rel_path from media_files f where f.recording_id = wanted.id and f.missing_since is null and not f.cached
      order by (f.album_id = wanted.album_id) desc nulls last, f.lossless desc, f.id limit 1
    ) best`) : []
  const paths = new Map(files.map((row) => [row.index, row.path]))
  const tracks = playlist.items.map(({ track }, index) => ({
    id: track.id, artist: track.artistCredit, title: track.title, album: track.album?.title ?? null,
    durationMs: track.durationMs, path: paths.get(index) ?? null,
  }))
  if (format === 'json') return JSON.stringify({ name: playlist.name, description: playlist.description, tracks }, null, 2) + '\n'
  if (format === 'm3u8') {
    const lines = tracks.flatMap((track) => {
      const label = oneLine(`${track.artist} - ${track.title}`)
      const path = track.path && !/[\r\n]/.test(track.path) ? `./${track.path}` : `#SQUIRMY-MISSING:${label}`
      return [`#EXTINF:${track.durationMs === null ? -1 : Math.round(track.durationMs / 1000)},${label}`, path]
    })
    return ['#EXTM3U', ...lines, ''].join('\n')
  }
  const nodes = tracks.map((track) => {
    const location = track.path ? `<location>./${xml(track.path.split('/').map(encodeURIComponent).join('/'))}</location>` : ''
    return `    <track>${location}<title>${xml(track.title)}</title><creator>${xml(track.artist)}</creator>${track.album ? `<album>${xml(track.album)}</album>` : ''}${track.durationMs === null ? '' : `<duration>${track.durationMs}</duration>`}</track>`
  })
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${xml(playlist.name)}</title>`, '  <trackList>', ...nodes, '  </trackList>', '</playlist>', ''].join('\n')
}
