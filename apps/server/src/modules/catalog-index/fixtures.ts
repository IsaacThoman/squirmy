import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

/**
 * Builders for synthetic canonical dumps in the real layout (see docs/local-search-index.md):
 * a zstd-compressed tar whose folder holds TIMESTAMP, COPYING and canonical/*.csv,
 * written with PAX headers as MetaBrainz's Python tarfile does. Tests only.
 */

export type DumpRecording = {
  recordingMbid: string
  recordingName: string
  artistMbids: string[]
  artistCredit: string
  releaseMbid: string
  releaseName: string
  /** Canonical release rank from the dump; lower is more canonical. */
  score: number
  /** Other recordings that redirect to this one (live takes, remasters). Default 0. */
  versions?: number
}

export type DumpRelease = { releaseMbid: string; releaseGroupMbid: string }

const BLOCK = 512

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name.slice(0, 99), 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write('15177064650\0', 136)
  block.write('        ', 148)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)])

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length++
  return `${length}${body}`
}

/** One tar member preceded by a PAX header carrying its full path. */
export function tarFile(path: string, data: Buffer): Buffer {
  const pax = Buffer.from(paxRecord('path', path) + paxRecord('mtime', '1794902403.2'))
  return Buffer.concat([
    header('././@PaxHeader', pax.length, 'x'), pad(pax),
    header(path.slice(-99), data.length, '0'), pad(data),
  ])
}

export function tarEnd(): Buffer {
  return Buffer.alloc(BLOCK * 2)
}

function csvField(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvLine(values: (string | number)[]): string {
  return `${values.map(csvField).join(',')}\n`
}

/** combined_lookup as MetaBrainz computes it, closely enough for fixtures. */
function combinedLookup(artist: string, title: string): string {
  return (artist + title).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}_]+/gu, '').toLowerCase()
}

export const canonicalHeader = 'id,artist_credit_id,artist_mbids,artist_credit_name,release_mbid,release_name,recording_mbid,recording_name,combined_lookup,score\n'

export function canonicalRow(row: DumpRecording, id: number): string {
  return csvLine([
    id, id, row.artistMbids.join(','), row.artistCredit, row.releaseMbid, row.releaseName,
    row.recordingMbid, row.recordingName, combinedLookup(row.artistCredit, row.recordingName), row.score,
  ])
}

/** A complete `.tar.zst` dump. */
export function buildDump(input: { recordings: DumpRecording[]; releases: DumpRelease[]; timestamp?: string; folder?: string }): Buffer {
  const folder = input.folder ?? 'musicbrainz-canonical-dump-20261117-080003'
  const data = canonicalHeader + input.recordings.map((row, index) => canonicalRow(row, index + 1)).join('')
  const recordingRedirect = 'recording_mbid,canonical_recording_mbid,canonical_release_mbid\n'
    + input.recordings.flatMap((row) => Array.from({ length: row.versions ?? 0 }, () => csvLine([randomUUID(), row.recordingMbid, row.releaseMbid]))).join('')
  const releaseRedirect = 'release_mbid,canonical_release_mbid,release_group_mbid\n'
    + input.releases.map((row) => csvLine([row.releaseMbid, row.releaseMbid, row.releaseGroupMbid])).join('')
  const tar = Buffer.concat([
    tarFile(`${folder}/TIMESTAMP`, Buffer.from(input.timestamp ?? '2026-11-17 08:00:03.201155')),
    tarFile(`${folder}/COPYING`, Buffer.from('Creative Commons Legal Code\n\nCC0 1.0 Universal\n')),
    tarFile(`${folder}/canonical/canonical_musicbrainz_data.csv`, Buffer.from(data)),
    tarFile(`${folder}/canonical/canonical_recording_redirect.csv`, Buffer.from(recordingRedirect)),
    tarFile(`${folder}/canonical/canonical_release_redirect.csv`, Buffer.from(releaseRedirect)),
    tarEnd(),
  ])
  return zstdCompressSync(tar)
}

/**
 * A small catalog for tests: a famous artist with a big catalog and a hit with many
 * versions, lesser artists with the same song titles, diacritics, non-Latin names
 * and the CSV quoting a real dump contains. Tests only.
 */
export type Catalog = { recordings: DumpRecording[]; releases: DumpRelease[]; ids: Record<string, string> }

export function testCatalog(options: { prefix?: string } = {}): Catalog {
  const prefix = options.prefix ?? ''
  const recordings: DumpRecording[] = []
  const releases: DumpRelease[] = []
  const ids: Record<string, string> = {}
  let rank = 0

  const artist = (name: string) => (ids[`artist:${name}`] ??= randomUUID())
  const album = (title: string, artistName: string, tracks: { title: string; versions?: number; key?: string }[], editions = 1) => {
    const releaseMbid = randomUUID()
    const group = (ids[`album:${title}`] ??= randomUUID())
    releases.push({ releaseMbid, releaseGroupMbid: group })
    for (let i = 1; i < editions; i++) releases.push({ releaseMbid: randomUUID(), releaseGroupMbid: group })
    rank += 1
    for (const track of tracks) {
      const recordingMbid = randomUUID()
      if (track.key) ids[`recording:${track.key}`] = recordingMbid
      recordings.push({
        recordingMbid, recordingName: `${prefix}${track.title}`, artistMbids: [artist(artistName)], artistCredit: artistName,
        releaseMbid, releaseName: `${prefix}${title}`, score: rank, versions: track.versions ?? 0,
      })
    }
  }

  album('Help!', 'The Beatles', [
    { title: 'Yesterday', versions: 60, key: 'beatles-yesterday' },
    { title: 'Help!', versions: 30 },
    { title: 'Ticket to Ride', versions: 20 },
  ], 40)
  album('Abbey Road', 'The Beatles', [
    { title: 'Come Together', versions: 25 },
    { title: 'Something', versions: 25 },
    { title: 'Here Comes the Sun', versions: 25 },
  ], 120)
  album('The Beatles Live Tapes', 'The Beatles', Array.from({ length: 40 }, (_, i) => ({ title: `Live Tape Track ${i + 1}` })))
  album('Yesterday Once More', 'Small Town Band', [{ title: 'Yesterday', key: 'small-yesterday' }])
  album('Abbey Rd. Tribute', 'The Beatles Revival', [{ title: 'Abbey Road Medley' }])
  album('Lemonade', 'Beyoncé', [{ title: 'Formation', versions: 8 }, { title: 'Hold Up', versions: 5 }], 6)
  album('Ágætis byrjun', 'Sigur Rós', [{ title: 'Svefn-g-englar', versions: 6 }, { title: 'Starálfur', versions: 4 }], 8)
  album('東京', 'くるり', [{ title: '東京', versions: 2 }])
  album('A Night at the Opera', 'Queen', [{ title: 'Bohemian Rhapsody', versions: 40 }, { title: "You're My Best Friend", versions: 10 }], 30)
  // The quoting a real dump has: commas, doubled quotes, line breaks, tabs, backslashes.
  album('Theme Time Radio Hour, Season 1', 'Bob Dylan', [
    { title: 'Theme Time Radio Hour "Friends & Neighbors"', key: 'quoted' },
    { title: 'Line one\nline two', key: 'multiline' },
    { title: 'Tab\there and back\\slash', key: 'escapes' },
  ])
  album('Obscure Demos', 'Nobody Special', [{ title: 'Kalomine Ravozeti', key: 'obscure' }])
  return { recordings, releases, ids }
}
