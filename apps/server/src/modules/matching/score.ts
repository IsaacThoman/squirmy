/**
 * Scores MusicBrainz releases against a group of files. Pure: no database, no network.
 *
 * Files are assigned to tracks one to one, preferring pairs whose disc and track numbers
 * agree, then by title and duration, so missing, extra and reordered tracks all work.
 * The score is a weighted mean of the parts in `MatchScoreBreakdown`; parts the files say
 * nothing about are left out and the remaining weights renormalized.
 */
import type { MatchCandidate, MatchScoreBreakdown } from '@squirmy/contracts'
import { matchKey } from '../../lib/text.js'
import type { MbRelease, MbTrack } from '../metadata/musicbrainz.js'

/** One file as the matcher sees it. */
export type FileEvidence = {
  id: string
  title: string | null
  artist: string | null
  disc: number | null
  track: number | null
  /** Null when unknown. */
  durationMs: number | null
  /** Recordings the file is known to be, from its tags or its fingerprint. */
  recordingMbids: string[]
}

/**
 * What a group of files says. `album` mode scores a whole release against an album;
 * `track` mode scores one loose file against the track it fits, ignoring the rest of the
 * release.
 */
export type GroupEvidence = {
  mode: 'album' | 'track'
  artist: string | null
  album: string | null
  year: number | null
  files: FileEvidence[]
}

export type TrackPair = { fileId: string; disc: number; position: number; similarity: number }

export type Evaluation = {
  score: number
  breakdown: MatchScoreBreakdown
  /** Assigned files, in release order. */
  pairs: TrackPair[]
  /** Files that fit no track. */
  extraFileIds: string[]
}

type FlatTrack = MbTrack & { disc: number; index: number }

/** Weights of the breakdown parts. They sum to 1 in each mode. */
export const weights = {
  album: { tracks: 0.3, files: 0.15, coverage: 0.2, title: 0.15, artist: 0.15, year: 0.05 },
  track: { tracks: 0.6, files: 0.15, coverage: 0, title: 0, artist: 0.25, year: 0 },
} as const

/** Pairs below this similarity are never assigned… */
const minPairSimilarity = 0.3
/** …unless disc and track number agree, which carries files with useless titles. */
const minPositionedSimilarity = 0.1
/** Added when ordering pairs when disc and track number agree. */
const positionBonus = 0.15
/** Share of a pair's part of the score that is disc and track number agreement. */
const positionWeight = 0.1
/** Durations this close agree fully; the agreement falls linearly to zero at `durationZeroMs`. */
const durationFullMs = 3_000
const durationZeroMs = 15_000
/** Comparisons on a shortened form of a title ("Album (Deluxe)" → "Album") count this much. */
const variantFactor = 0.9
/** Video media are not something a folder of audio files can cover. */
const videoFormat = /dvd|blu-ray|vhs|laserdisc|hd-dvd/i

function levenshtein(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}

function ratio(a: string, b: string): number {
  if (a === b) return 1
  const left = Array.from(a)
  const right = Array.from(b)
  const longest = Math.max(left.length, right.length)
  return longest === 0 ? 0 : 1 - levenshtein(left, right) / longest
}

/** The full key plus shortened forms: without bracketed parts, and before a subtitle separator. */
function variants(value: string): string[] {
  const text = value.normalize('NFKC')
  const bare = text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  const head = text.split(/\s[-–—/]\s|:\s|\s(?:feat|ft)\.?\s/i)[0] ?? text
  return [...new Set([matchKey(text), matchKey(bare), matchKey(head)])].filter(Boolean)
}

/**
 * 0..1 similarity of two names on their `matchKey`: edit distance, with a little less
 * credit for agreeing only once bracketed parts or subtitles are dropped, so
 * "Get Lucky (feat. Pharrell Williams)" is close to "Get Lucky".
 */
export function textSimilarity(a: string, b: string): number {
  const left = variants(a)
  const right = variants(b)
  let best = 0
  for (const [i, x] of left.entries()) {
    for (const [j, y] of right.entries()) best = Math.max(best, ratio(x, y) * (i === 0 && j === 0 ? 1 : variantFactor))
  }
  return best
}

/** 1 within three seconds, falling linearly to 0 at fifteen; null when either is unknown. */
export function durationSimilarity(a: number | null, b: number | null): number | null {
  if (!a || !b) return null
  const difference = Math.abs(a - b)
  if (difference <= durationFullMs) return 1
  return Math.max(0, 1 - (difference - durationFullMs) / (durationZeroMs - durationFullMs))
}

/** 1 for the same year, falling to 0 five years apart; null when either is unknown. */
export function yearSimilarity(a: number | null, b: number | null): number | null {
  if (!a || !b) return null
  return Math.max(0, 1 - Math.abs(a - b) / 5)
}

/** A file against one track: title (or a recording id the file is known to be) and duration. */
export function pairSimilarity(file: FileEvidence, track: MbTrack): number {
  const known = file.recordingMbids.includes(track.recording.mbid)
  const title = known ? 1 : file.title ? Math.max(textSimilarity(file.title, track.title), textSimilarity(file.title, track.recording.title)) : null
  const duration = durationSimilarity(file.durationMs, track.durationMs ?? track.recording.durationMs)
  // Without a title, a duration alone is weak evidence: many songs are four minutes long.
  if (title === null) return duration === null ? 0 : duration * 0.5
  if (duration === null) return title
  return title * 0.7 + duration * 0.3
}

function artistSimilarity(tagged: string, release: Pick<MbTrack, 'artistCredit' | 'artistName'>): number {
  const first = release.artistCredit[0]?.name
  return Math.max(textSimilarity(tagged, release.artistName), first ? textSimilarity(tagged, first) * variantFactor : 0)
}

function flatten(release: MbRelease): FlatTrack[] {
  const audio = release.mediums.filter((medium) => !videoFormat.test(medium.format ?? ''))
  const mediums = audio.length > 0 ? audio : release.mediums
  let index = 0
  return mediums.flatMap((medium) => medium.tracks.map((track) => ({ ...track, disc: medium.position, index: ++index })))
}

function positionAgrees(file: FileEvidence, track: FlatTrack): boolean {
  if (file.track === null) return false
  if (file.disc !== null) return file.disc === track.disc && file.track === track.position
  // Untagged discs: either per-disc numbering on the first disc, or numbering across discs.
  return (track.disc === 1 && file.track === track.position) || file.track === track.index
}

/** One-to-one assignment: the best remaining pair first, position agreement breaking ties. */
function assign(files: FileEvidence[], tracks: FlatTrack[]) {
  const candidates: { file: FileEvidence; track: FlatTrack; similarity: number; rank: number }[] = []
  for (const file of files) {
    for (const track of tracks) {
      const similarity = pairSimilarity(file, track)
      const positioned = positionAgrees(file, track)
      if (similarity < (positioned ? minPositionedSimilarity : minPairSimilarity)) continue
      candidates.push({ file, track, similarity, rank: similarity + (positioned ? positionBonus : 0) })
    }
  }
  candidates.sort((a, b) => b.rank - a.rank)
  const usedFiles = new Set<string>()
  const usedTracks = new Set<number>()
  const pairs: { file: FileEvidence; track: FlatTrack; similarity: number }[] = []
  for (const candidate of candidates) {
    if (usedFiles.has(candidate.file.id) || usedTracks.has(candidate.track.index)) continue
    usedFiles.add(candidate.file.id)
    usedTracks.add(candidate.track.index)
    pairs.push(candidate)
  }
  return pairs.sort((a, b) => a.track.index - b.track.index)
}

/** Scores `release` against the evidence. */
export function evaluate(evidence: GroupEvidence, release: MbRelease): Evaluation {
  const tracks = flatten(release)
  const pairs = assign(evidence.files, tracks)
  const assigned = new Set(pairs.map((pair) => pair.file.id))
  const fileCount = evidence.files.length

  // A file numbered where the track sits earns a little, so the edition with the files'
  // disc layout beats a one-medium pressing of the same songs.
  // A loose file's track number belongs to wherever it came from, so it is not compared.
  const pairScore = (pair: (typeof pairs)[number]) => (pair.file.track === null || evidence.mode === 'track'
    ? pair.similarity
    : pair.similarity * (1 - positionWeight) + (positionAgrees(pair.file, pair.track) ? positionWeight : 0))
  const trackPart = pairs.length === 0 ? 0 : pairs.reduce((sum, pair) => sum + pairScore(pair), 0) / pairs.length
  // Weighted by fit, so files forced onto the wrong album's tracks do not count as covered.
  const fitted = pairs.reduce((sum, pair) => sum + pair.similarity, 0)
  const filesPart = fileCount === 0 ? 0 : fitted / fileCount
  let breakdown: MatchScoreBreakdown
  if (evidence.mode === 'album') {
    const title = evidence.album
      ? Math.max(textSimilarity(evidence.album, release.title), textSimilarity(evidence.album, release.releaseGroup.title) * variantFactor)
      : null
    const releaseYear = yearSimilarity(evidence.year, release.year)
    const firstYear = yearSimilarity(evidence.year, release.releaseGroup.year)
    breakdown = {
      tracks: trackPart,
      files: filesPart,
      coverage: tracks.length === 0 ? 0 : fitted / tracks.length,
      title,
      artist: evidence.artist ? artistSimilarity(evidence.artist, release) : null,
      year: releaseYear === null && firstYear === null ? null : Math.max(releaseYear ?? 0, (firstYear ?? 0) * 0.8),
    }
  } else {
    // A loose track is compared with the artist of the track it landed on.
    const landed = pairs[0]?.track
    breakdown = {
      tracks: trackPart,
      files: filesPart,
      coverage: null,
      title: null,
      artist: evidence.artist ? artistSimilarity(evidence.artist, landed ?? release) : null,
      year: null,
    }
  }

  const weight = weights[evidence.mode]
  let total = 0
  let sum = 0
  for (const part of Object.keys(weight) as (keyof typeof weight)[]) {
    const value = breakdown[part]
    if (value === null || weight[part] === 0) continue
    total += value * weight[part]
    sum += weight[part]
  }
  return {
    score: sum === 0 ? 0 : total / sum,
    breakdown,
    pairs: pairs.map((pair) => ({ fileId: pair.file.id, disc: pair.track.disc, position: pair.track.position, similarity: pair.similarity })),
    extraFileIds: evidence.files.filter((file) => !assigned.has(file.id)).map((file) => file.id),
  }
}

/** Medium formats as one string: "CD", "2×CD", "CD + DVD-Video". */
export function formatSummary(release: Pick<MbRelease, 'media'>): string | null {
  const counts = new Map<string, number>()
  for (const medium of release.media) counts.set(medium.format ?? 'Unknown', (counts.get(medium.format ?? 'Unknown') ?? 0) + 1)
  if (counts.size === 0) return null
  return [...counts].map(([format, count]) => (count > 1 ? `${count}×${format}` : format)).join(' + ')
}

/** The release and its evaluation in the shape reviews store and the API returns. */
export function toCandidate(release: MbRelease, evaluation: Evaluation): MatchCandidate {
  const byPosition = new Map(evaluation.pairs.map((pair) => [`${pair.disc}:${pair.position}`, pair]))
  return {
    releaseMbid: release.mbid,
    releaseGroupMbid: release.releaseGroup.mbid,
    title: release.title,
    artistCredit: release.artistName,
    date: release.date,
    country: release.country,
    status: release.status,
    format: formatSummary(release),
    label: release.labels[0]?.name ?? null,
    catalogNumber: release.labels[0]?.catalogNumber ?? null,
    barcode: release.barcode,
    disambiguation: release.disambiguation,
    trackCount: release.trackCount,
    discCount: release.mediums.length,
    score: evaluation.score,
    breakdown: evaluation.breakdown,
    tracks: release.mediums.flatMap((medium) => medium.tracks.map((track) => {
      const pair = byPosition.get(`${medium.position}:${track.position}`)
      return {
        disc: medium.position,
        position: track.position,
        title: track.title,
        durationMs: track.durationMs,
        fileId: pair?.fileId ?? null,
        similarity: pair?.similarity ?? null,
      }
    })),
    extraFileIds: evaluation.extraFileIds,
  }
}

export type ScoredRelease = { release: MbRelease; evaluation: Evaluation }

/** Formats files are most often ripped or bought from. */
export const preferredFormat = /^(cd|digital media)$/i

/** Sorts earlier dates first, and a full date before a bare year or month within it. */
export function dateOrder(date: string | null): string {
  return date ? `${date}-99-99`.slice(0, 10) : '9999'
}

/**
 * Best first. Near-equal scores (many pressings share a track list) fall back to official
 * releases, CDs and digital releases, the earliest date, then the MBID so the order is
 * stable.
 */
export function rank<T extends ScoredRelease>(candidates: T[]): T[] {
  const key = ({ release, evaluation }: T) => [
    -Math.round(evaluation.score * 1000),
    release.status === 'official' ? 0 : 1,
    release.media.every((medium) => preferredFormat.test(medium.format ?? '')) ? 0 : 1,
    dateOrder(release.date),
    release.mbid,
  ] as const
  return [...candidates].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
    }
    return 0
  })
}
