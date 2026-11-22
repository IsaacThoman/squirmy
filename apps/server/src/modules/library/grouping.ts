/**
 * How files become albums. Everything here is pure, so the rules are tested directly.
 *
 * Group key: files with the same key are one album.
 *
 * - The folder is the file's parent directory, except that a disc subfolder (`CD1`,
 *   `Disc 2`, `disk3`, `CD 1 - Bonus`) counts as its parent: `Album/CD1/01.flac` and
 *   `Album/CD2/01.flac` share the folder `Album`.
 * - A file with an album tag: `<root>|<folder>|<matchKey(album artist tag)>|<matchKey(album)>`.
 *   The album artist part is empty when the tag is missing, so an untagged compilation in
 *   one folder is still one group; the album artist is decided when the group is ingested.
 * - A file without an album tag but with an artist: `<root>|<folder>|<matchKey(artist)>|`.
 *   Loose files in one folder by one artist form one synthetic album named after the
 *   folder; a lone file becomes a single named after its title.
 * - A file with neither: `<root>|file:<path>`, its own single.
 */
import path from 'node:path'
import type { FileTags } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'

/** One artist in a credit, followed by the text that joins it to the next. */
export type Credit = { name: string; joinPhrase: string; mbid?: string }

export const VARIOUS_ARTISTS = 'Various Artists'
/** MusicBrainz's special purpose artist for compilations. */
export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377'
export const UNKNOWN_ARTIST = 'Unknown Artist'
export const UNKNOWN_ALBUM = 'Unknown Album'

const discFolder = /^(?:cd|dis[ck]|dvd)[\s._-]*(\d{1,2})(?:\s*[-–:].*)?$/i
const featuring = /(\s+|\s*[([]\s*)(feat\.?|ft\.?|featuring)\s+/i

/**
 * Splits featured artists out of an artist string: "A feat. B", "A ft. B", "A (featuring B)".
 * `&`, `,` and `/` are never split, because they are part of too many names. When the file
 * has a multi-value artists tag, its names are used and the join phrases are read from the
 * display string. `mbids` are matched to names by position when the counts agree.
 */
export function parseCredits(display: string | undefined, names?: readonly string[], mbids: readonly string[] = []): Credit[] {
  const text = display?.trim()
  const credits = names && names.length > 0 ? creditsFromNames(text, names) : text ? splitFeaturing(text) : []
  return credits.map((credit, index) => {
    const mbid = mbids.length === credits.length ? mbids[index] : credits.length === 1 ? mbids[0] : undefined
    return mbid ? { ...credit, mbid } : credit
  })
}

function splitFeaturing(text: string): Credit[] {
  const match = featuring.exec(text)
  const main = match ? text.slice(0, match.index).trim() : ''
  if (!match || !main) return [{ name: text, joinPhrase: '' }]
  let rest = text.slice(match.index + match[0].length).trim()
  if (match[1]!.trim()) rest = rest.replace(/\s*[)\]]\s*$/, '')
  if (!rest) return [{ name: main, joinPhrase: '' }]
  const word = match[2]!.toLowerCase().replace(/\.$/, '')
  return [{ name: main, joinPhrase: ` ${word === 'featuring' ? word : `${word}.`} ` }, ...splitFeaturing(rest)]
}

function creditsFromNames(display: string | undefined, names: readonly string[]): Credit[] {
  const lower = display?.toLowerCase() ?? ''
  const starts: number[] = []
  let from = 0
  for (const name of names) {
    const index = lower.indexOf(name.toLowerCase(), from)
    if (index < 0) break
    starts.push(index)
    from = index + name.length
  }
  if (display && starts.length === names.length) {
    return names.map((name, index) => ({
      name,
      joinPhrase: display.slice(starts[index]! + name.length, index + 1 < names.length ? starts[index + 1] : undefined),
    }))
  }
  return names.map((name, index) => ({ name, joinPhrase: index === names.length - 1 ? '' : index === names.length - 2 ? ' & ' : ', ' }))
}

/** The display string of a credit: "Daft Punk feat. Pharrell Williams". */
export function creditText(credits: readonly Credit[]): string {
  return credits.map((credit) => credit.name + credit.joinPhrase).join('').trim()
}

/** The album folder of a file (disc subfolders folded into their parent) and the disc it implies. */
export function albumFolder(relPath: string): { dir: string; disc?: number } {
  const parent = path.posix.dirname(relPath)
  const dir = parent === '.' ? '' : parent
  const match = discFolder.exec(path.posix.basename(dir))
  if (!match) return { dir }
  const up = path.posix.dirname(dir)
  return { dir: up === '.' ? '' : up, disc: Number(match[1]) }
}

function primaryArtist(tags: FileTags): string | undefined {
  return parseCredits(tags.albumArtist ?? tags.artist, tags.albumArtist ? undefined : tags.artists)[0]?.name
}

/** The album group a file belongs to. See the rules at the top of this file. */
export function groupKeyFor(rootId: string, relPath: string, tags: FileTags): string {
  const { dir } = albumFolder(relPath)
  const album = matchKey(tags.album ?? '')
  if (album) return [rootId, dir, matchKey(tags.albumArtist ?? ''), album].join('|')
  const artist = matchKey(primaryArtist(tags) ?? '')
  if (artist) return [rootId, dir, artist, ''].join('|')
  return `${rootId}|file:${relPath}`
}

export type GroupFile = { id: string; relPath: string; tags: FileTags; durationMs: number }

export type TrackPlan = {
  fileId: string
  disc: number
  position: number
  title: string
  credits: Credit[]
  mbRecordingId?: string
  mbTrackId?: string
  isrcs: string[]
  durationMs: number
}

export type GroupPlan = {
  album: {
    title: string
    type: 'album' | 'single' | 'compilation'
    credits: Credit[]
    year?: number
    date?: string
    genres: string[]
    mbReleaseGroupId?: string
  }
  release: { title: string; date?: string; label?: string; catalogNumber?: string; barcode?: string; mbReleaseId?: string; discCount: number }
  /** Ordered by disc and position. Copies of one track share a position. */
  tracks: TrackPlan[]
}

/** The most frequent value; ties go to the one seen first. */
function mostCommon<T>(values: readonly (T | undefined)[], key: (value: T) => string = String): T | undefined {
  const counts = new Map<string, { value: T; count: number }>()
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    const entry = counts.get(key(value)) ?? { value, count: 0 }
    entry.count += 1
    counts.set(key(value), entry)
  }
  let best: { value: T; count: number } | undefined
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry
  return best?.value
}

/** "02 - Karma Police.mp3" → "Karma Police". */
function titleFromPath(relPath: string): string {
  const stem = path.posix.basename(relPath).replace(/\.[^.]+$/, '')
  return stem.replace(/^(?:\d{1,2}[-.])?\d{1,3}\s*[-._)]?\s+(?=\S)/, '').trim() || stem
}

const variousArtists = (): Credit[] => [{ name: VARIOUS_ARTISTS, joinPhrase: '', mbid: VARIOUS_ARTISTS_MBID }]

/**
 * The album artist of a group: the album artist tag when present; Various Artists when a
 * file is flagged as part of a compilation; the track artist when every track agrees (in
 * full, or else on the main artist); Various Artists otherwise. An album artist tag that
 * is a track's several artists run together ("Tiga, Fcukers", where the track names Tiga
 * and Fcukers) credits those artists: split by the track's names, never by punctuation.
 */
function albumCredits(files: readonly GroupFile[], trackCredits: readonly Credit[][]): Credit[] {
  const tagged = mostCommon(files.map((file) => file.tags.albumArtist), matchKey)
  if (tagged) {
    if (matchKey(tagged) === matchKey(VARIOUS_ARTISTS)) return variousArtists()
    const named = trackCredits.find((credits) => credits.length > 1 && matchKey(creditText(credits)) === matchKey(tagged))
    if (named) return named
    const mbids = mostCommon(files.map((file) => file.tags.mbAlbumArtistIds), (ids) => ids.join(',')) ?? []
    return parseCredits(tagged, undefined, mbids)
  }
  if (files.some((file) => file.tags.compilation)) return variousArtists()
  const credited = trackCredits.filter((credits) => credits.length > 0)
  if (credited.length === 0) return [{ name: UNKNOWN_ARTIST, joinPhrase: '' }]
  const [first] = credited as [Credit[], ...Credit[][]]
  if (credited.every((credits) => matchKey(creditText(credits)) === matchKey(creditText(first)))) return first
  if (credited.every((credits) => matchKey(credits[0]!.name) === matchKey(first[0]!.name))) return [{ ...first[0]!, joinPhrase: '' }]
  return variousArtists()
}

/** Turns the files of one group into the album, release and track list to store. */
export function planGroup(files: readonly GroupFile[]): GroupPlan {
  const trackCredits = files.map((file) => parseCredits(file.tags.artist, file.tags.artists, file.tags.mbArtistIds))
  const credits = albumCredits(files, trackCredits)
  const albumTitle = mostCommon(files.map((file) => file.tags.album), matchKey)
  const single = !albumTitle && files.length === 1
  const folder = path.posix.basename(albumFolder(files[0]!.relPath).dir)
  const title = albumTitle ?? (single ? files[0]!.tags.title ?? titleFromPath(files[0]!.relPath) : folder || UNKNOWN_ALBUM)
  const compilation = credits[0]?.mbid === VARIOUS_ARTISTS_MBID || files.some((file) => file.tags.compilation)
  const year = mostCommon(files.map((file) => file.tags.year))
  const dates = files.map((file) => file.tags.date).filter((date) => date && (!year || date.startsWith(String(year))))
  const date = mostCommon(dates.sort((a, b) => b!.length - a!.length)) ?? (year ? String(year) : undefined)
  const genres = new Map<string, string>()
  for (const genre of files.flatMap((file) => file.tags.genres ?? [])) if (!genres.has(matchKey(genre))) genres.set(matchKey(genre), genre)

  const tracks = assignPositions(files).map(({ file, disc, position }) => {
    const index = files.indexOf(file)
    return {
      fileId: file.id,
      disc,
      position,
      title: file.tags.title ?? titleFromPath(file.relPath),
      credits: trackCredits[index]!.length > 0 ? trackCredits[index]! : credits,
      mbRecordingId: file.tags.mbRecordingId,
      mbTrackId: file.tags.mbTrackId,
      isrcs: file.tags.isrcs ?? [],
      durationMs: file.durationMs,
    }
  })

  return {
    album: {
      title,
      type: single ? 'single' : compilation ? 'compilation' : 'album',
      credits,
      year,
      date,
      genres: [...genres.values()].slice(0, 10),
      mbReleaseGroupId: mostCommon(files.map((file) => file.tags.mbReleaseGroupId)),
    },
    release: {
      title,
      date,
      label: mostCommon(files.map((file) => file.tags.label)),
      catalogNumber: mostCommon(files.map((file) => file.tags.catalogNumber)),
      barcode: mostCommon(files.map((file) => file.tags.barcode)),
      mbReleaseId: mostCommon(files.map((file) => file.tags.mbReleaseId)),
      discCount: Math.max(1, ...tracks.map((track) => track.disc), ...files.map((file) => file.tags.discTotal ?? 1)),
    },
    tracks,
  }
}

/**
 * Track numbers from the tags where they are free. Two files with one number and the same
 * title are copies of one track and share it; with different titles the later file moves
 * to the end of its disc, as do files without a number.
 */
function assignPositions(files: readonly GroupFile[]) {
  const discOf = (file: GroupFile) => file.tags.disc ?? albumFolder(file.relPath).disc ?? 1
  const ordered = [...files].sort((a, b) =>
    discOf(a) - discOf(b) || (a.tags.track ?? Infinity) - (b.tags.track ?? Infinity) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  const taken = new Map<number, Map<number, string>>()
  const placed: { file: GroupFile; disc: number; position: number }[] = []
  const deferred: GroupFile[] = []
  const titleKey = (file: GroupFile) => matchKey(file.tags.title ?? titleFromPath(file.relPath))

  for (const file of ordered) {
    const disc = discOf(file)
    const positions = taken.get(disc) ?? new Map<number, string>()
    taken.set(disc, positions)
    const position = file.tags.track
    if (position === undefined || position > 32_000) {
      deferred.push(file)
      continue
    }
    const holder = positions.get(position)
    if (holder !== undefined && holder !== titleKey(file)) {
      deferred.push(file)
      continue
    }
    positions.set(position, titleKey(file))
    placed.push({ file, disc, position })
  }
  for (const file of deferred) {
    const disc = discOf(file)
    const positions = taken.get(disc)!
    const position = Math.max(0, ...positions.keys()) + 1
    positions.set(position, titleKey(file))
    placed.push({ file, disc, position })
  }
  return placed.sort((a, b) => a.disc - b.disc || a.position - b.position)
}
