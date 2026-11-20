import { describe, expect, it } from 'vitest'
import { demoAlbums, type DemoTrack } from '../../test/matching.js'
import type { MbRelease } from '../metadata/musicbrainz.js'
import { dateOrder, durationSimilarity, evaluate, rank, textSimilarity, toCandidate, yearSimilarity, type FileEvidence, type GroupEvidence } from './score.js'

const radiohead = [{ name: 'Radiohead', mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', joinPhrase: '' }]
const okComputer = demoAlbums.okComputer.tracks
const bonus: DemoTrack[] = [
  { title: 'I Promise', durationMs: 239_000 }, { title: 'Man of War', durationMs: 268_000 }, { title: 'Lift', durationMs: 247_000 },
  { title: 'Lull', durationMs: 147_000 }, { title: 'Meeting in the Aisle', durationMs: 188_000 }, { title: 'Melatonin', durationMs: 128_000 },
  { title: 'A Reminder', durationMs: 230_000 }, { title: 'Polyethylene (Parts 1 & 2)', durationMs: 263_000 }, { title: 'Pearly*', durationMs: 214_000 },
  { title: 'Palo Alto', durationMs: 224_000 }, { title: 'How I Made My Millions', durationMs: 186_000 },
]

let serial = 0
const mbid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`

/** A release with one medium per list of tracks. */
function release(title: string, discs: DemoTrack[][], extra: Partial<MbRelease> = {}): MbRelease {
  const mediums = discs.map((tracks, index) => ({
    position: index + 1,
    format: 'CD',
    title: '',
    tracks: tracks.map((track, position) => ({
      mbid: mbid(),
      position: position + 1,
      number: String(position + 1),
      title: track.title,
      durationMs: track.durationMs,
      artistCredit: radiohead,
      artistName: 'Radiohead',
      recording: { mbid: mbid(), title: track.title, durationMs: track.durationMs, disambiguation: '', video: false, artistCredit: radiohead, artistName: 'Radiohead', isrcs: [] },
    })),
  }))
  return {
    mbid: mbid(), title, status: 'official', country: 'GB', barcode: null, disambiguation: '', artistCredit: radiohead, artistName: 'Radiohead',
    date: '1997-06-16', year: 1997, labels: [], urls: [],
    media: mediums.map((medium) => ({ format: medium.format, trackCount: medium.tracks.length })),
    trackCount: mediums.reduce((sum, medium) => sum + medium.tracks.length, 0),
    releaseGroup: {
      mbid: 'b1392450-e666-3926-a536-22c65f834433', title: 'OK Computer', type: 'album', primaryType: 'Album', secondaryTypes: [], disambiguation: '',
      artistCredit: radiohead, artistName: 'Radiohead', date: '1997-05-21', year: 1997,
    },
    mediums,
    ...extra,
  }
}

/** Files as tags describe them; `null` fields are left untagged. */
function files(tracks: DemoTrack[], change: (track: DemoTrack, index: number) => Partial<FileEvidence> = () => ({})): FileEvidence[] {
  return tracks.map((track, index) => ({
    id: `file-${index + 1}`, title: track.title, artist: 'Radiohead', disc: track.disc ?? null, track: index + 1, durationMs: track.durationMs, recordingMbids: [],
    ...change(track, index),
  }))
}

const album = (evidenceFiles: FileEvidence[], extra: Partial<GroupEvidence> = {}): GroupEvidence => ({
  mode: 'album', artist: 'Radiohead', album: 'OK Computer', year: 1997, files: evidenceFiles, ...extra,
})

const original = release('OK Computer', [okComputer])
const deluxe = release('OK Computer: OKNOTOK 1997 2017', [okComputer, bonus], { date: '2017-06-23', year: 2017 })

describe('text, duration and year similarity', () => {
  it.each([
    ['OK Computer', 'OK Computer', 1],
    ['Exit Music (For a Film)', 'Exit Music (for a film)', 1],
    ['Harder, Better, Faster, Stronger', 'Harder Better Faster Stronger', 1],
    ['In the Flesh?', 'In the Flesh', 1],
    ['幸福論(悦楽編)', '幸福論 (悦楽編)', 1],
    ['Beyoncé', 'Beyonce', 1],
    ['Get Lucky', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 0.9],
    ['Guardians of the Galaxy: Awesome Mix Vol. 1', 'Guardians of the Galaxy: Awesome Mix, Vol. 1: Original Motion Picture Soundtrack', 0.9],
    ['OK Computer', 'OK Computer: OKNOTOK 1997 2017', 0.9],
  ])('%s ≈ %s', (a, b, expected) => {
    expect(textSimilarity(a, b)).toBeCloseTo(expected, 5)
  })

  it.each([
    ['Airbag', 'Lucky', 0.4],
    ['Track 01', 'Paranoid Android', 0.3],
    ['正しい街', '警告', 0.1],
  ])('%s is not %s', (a, b, below) => {
    expect(textSimilarity(a, b)).toBeLessThan(below)
  })

  it.each([
    [240_000, 240_000, 1],
    [240_000, 243_000, 1],
    [240_000, 249_000, 0.5],
    [240_000, 255_000, 0],
    [240_000, 300_000, 0],
    [240_000, null, null],
    [0, 240_000, null],
  ])('durations %s and %s agree %s', (a, b, expected) => {
    expect(durationSimilarity(a, b)).toBe(expected)
  })

  it.each([
    [1997, 1997, 1],
    [1997, 1999, 0.6],
    [1997, 2009, 0],
    [null, 1997, null],
  ])('years %s and %s agree %s', (a, b, expected) => {
    expect(yearSimilarity(a, b)).toBeCloseTo(expected as number, 5)
  })
})

describe('evaluate', () => {
  it.each([
    { name: 'clean tags', evidence: album(files(okComputer)), min: 0.99, max: 1, extras: 0 },
    {
      name: 'reordered files',
      evidence: album(files([...okComputer].reverse(), (_track, index) => ({ track: 12 - index }))),
      min: 0.99, max: 1, extras: 0,
    },
    { name: 'two tracks missing', evidence: album(files(okComputer.slice(0, 10))), min: 0.9, max: 0.98, extras: 0 },
    { name: 'a bonus file', evidence: album(files([...okComputer, bonus[0]!])), min: 0.9, max: 0.99, extras: 1 },
    { name: 'durations ten seconds out', evidence: album(files(okComputer, (track) => ({ durationMs: track.durationMs + 10_000 }))), min: 0.85, max: 0.97, extras: 0 },
    { name: 'generic titles', evidence: album(files(okComputer, (_track, index) => ({ title: `Track ${index + 1}` })), { year: null }), min: 0.5, max: 0.9, extras: 0 },
    { name: 'no titles, but fingerprints', evidence: album(files(okComputer, (_track, index) => ({ title: null, track: null, recordingMbids: [original.mediums[0]!.tracks[index]!.recording.mbid] })), { album: null, artist: null, year: null }), min: 0.99, max: 1, extras: 0 },
    {
      name: 'another album by the same artist',
      evidence: album(files(demoAlbums.discovery.tracks), { album: 'Discovery', year: 2001 }),
      min: 0, max: 0.4, extras: 7,
    },
  ])('$name', ({ evidence, min, max, extras }) => {
    const result = evaluate(evidence, original)
    expect(result.score).toBeGreaterThanOrEqual(min)
    expect(result.score).toBeLessThanOrEqual(max)
    expect(result.extraFileIds).toHaveLength(extras)
  })

  it('assigns reordered files to the tracks their titles name', () => {
    const shuffled = files([okComputer[5]!, okComputer[0]!, okComputer[11]!], (_track, index) => ({ track: index + 1 }))
    const result = evaluate(album(shuffled), original)
    expect(result.pairs.map((pair) => [pair.fileId, pair.position])).toEqual([['file-2', 1], ['file-1', 6], ['file-3', 12]])
  })

  it('falls back to disc and track numbers when titles say nothing', () => {
    const result = evaluate(album(files(okComputer, () => ({ title: null }))), original)
    expect(result.pairs.map((pair) => pair.position)).toEqual(okComputer.map((_track, index) => index + 1))
  })

  it('reads track numbers across discs when the disc tag is missing', () => {
    const tracks = [...okComputer, ...bonus]
    const result = evaluate(album(files(tracks, () => ({ title: null })), { album: 'OK Computer OKNOTOK 1997 2017', year: 2017 }), deluxe)
    expect(result.pairs.map((pair) => `${pair.disc}:${pair.position}`).slice(11, 14)).toEqual(['1:12', '2:1', '2:2'])
  })

  it('prefers the edition with the same number of tracks, both ways', () => {
    const twelve = album(files(okComputer))
    expect(evaluate(twelve, original).score).toBeGreaterThan(evaluate(twelve, deluxe).score + 0.05)
    expect(evaluate(twelve, deluxe).score).toBeLessThan(0.9)

    const all = [...okComputer.map((track) => ({ ...track, disc: 1 })), ...bonus.map((track) => ({ ...track, disc: 2 }))]
    const twentyThree = album(files(all, (track, index) => ({ track: index < 12 ? index + 1 : index - 11, disc: track.disc! })), { album: 'OK Computer OKNOTOK 1997 2017', year: 2017 })
    expect(evaluate(twentyThree, deluxe).score).toBeGreaterThan(0.99)
    expect(evaluate(twentyThree, original).score).toBeLessThan(0.9)
  })

  it('prefers the pressing whose discs match the files', () => {
    const all = [...okComputer.map((track) => ({ ...track, disc: 1 })), ...bonus.map((track) => ({ ...track, disc: 2 }))]
    const evidence = album(files(all, (track, index) => ({ track: index < 12 ? index + 1 : index - 11, disc: track.disc! })))
    const digital = release('OK Computer: OKNOTOK 1997 2017', [[...okComputer, ...bonus]], { date: '2017-06-23', year: 2017 })
    expect(evaluate(evidence, deluxe).score).toBeGreaterThan(evaluate(evidence, digital).score)
  })

  it('scores a loose track against the one track it fits', () => {
    const loose: GroupEvidence = { mode: 'track', artist: 'Radiohead', album: null, year: null, files: files([okComputer[5]!]) }
    const result = evaluate(loose, original)
    expect(result.score).toBeGreaterThan(0.99)
    expect(result.breakdown).toMatchObject({ coverage: null, title: null, year: null })
    expect(result.pairs).toEqual([{ fileId: 'file-1', disc: 1, position: 6, similarity: 1 }])
  })

  it('leaves out what the files do not say', () => {
    const result = evaluate(album(files(okComputer), { album: null, artist: null, year: null }), original)
    expect(result.breakdown).toMatchObject({ title: null, artist: null, year: null })
    expect(result.score).toBeGreaterThan(0.99)
  })

  it('describes a candidate with every track and the file on it', () => {
    const candidate = toCandidate(deluxe, evaluate(album(files(okComputer)), deluxe))
    expect(candidate).toMatchObject({ title: 'OK Computer: OKNOTOK 1997 2017', format: '2×CD', trackCount: 23, discCount: 2, extraFileIds: [] })
    expect(candidate.tracks).toHaveLength(23)
    expect(candidate.tracks[0]).toMatchObject({ disc: 1, position: 1, title: 'Airbag', fileId: 'file-1', similarity: 1 })
    expect(candidate.tracks[12]).toMatchObject({ disc: 2, position: 1, title: 'I Promise', fileId: null, similarity: null })
  })
})

describe('rank', () => {
  it('orders by score, then official CDs with the most precise earliest date', () => {
    const evidence = album(files(okComputer))
    const pressings = [
      release('OK Computer', [okComputer], { status: 'bootleg' }),
      release('OK Computer', [okComputer], { date: '1997' }),
      release('OK Computer', [okComputer], { date: '1997-06-16', media: [{ format: 'Cassette', trackCount: 12 }] }),
      release('OK Computer', [okComputer], { date: '1997-05-21' }),
      release('OK Computer', [okComputer.slice(0, 11)]),
    ].map((candidate) => ({ release: candidate, evaluation: evaluate(evidence, candidate) }))
    expect(rank(pressings).map((entry) => pressings.indexOf(entry))).toEqual([3, 1, 2, 0, 4])
    expect(dateOrder('1997')).toBe('1997-99-99')
    expect(dateOrder(null)).toBe('9999')
  })
})
