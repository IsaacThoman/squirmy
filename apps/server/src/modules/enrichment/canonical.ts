import type { MbReleaseSummary } from '../metadata/musicbrainz.js'
import { dateOrder, preferredFormat } from '../matching/score.js'

/** Official first; promotional copies, bootlegs and pseudo-releases only when nothing better exists. */
const statusRank = (status: string | null) => {
  switch (status) {
    case 'official': return 0
    case null: return 1
    case 'promotion': return 2
    case 'bootleg': return 3
    default: return 4
  }
}

/**
 * The edition an album page shows, from a release group's releases:
 *
 * 1. Only releases of the best status present (official over unknown, promotion, bootleg).
 * 2. Of those, the most common track count, so a deluxe edition or a bonus-track pressing
 *    does not stand for the album (a tie goes to the count with the earliest release).
 * 3. Of those, CD or digital releases over vinyl and cassettes, whose sides split discs
 *    oddly; then the earliest date (the original edition); then the MBID, so the choice
 *    is stable.
 *
 * Null for a group without releases.
 */
export function chooseCanonicalRelease(releases: readonly MbReleaseSummary[]): MbReleaseSummary | null {
  if (releases.length === 0) return null
  const best = Math.min(...releases.map((release) => statusRank(release.status)))
  const candidates = releases.filter((release) => statusRank(release.status) === best)

  const counts = new Map<number, { count: number; earliest: string }>()
  for (const release of candidates) {
    const entry = counts.get(release.trackCount) ?? { count: 0, earliest: '9999' }
    entry.count += 1
    if (dateOrder(release.date) < entry.earliest) entry.earliest = dateOrder(release.date)
    counts.set(release.trackCount, entry)
  }
  const [trackCount] = [...counts].sort(([, a], [, b]) => b.count - a.count || (a.earliest < b.earliest ? -1 : a.earliest > b.earliest ? 1 : 0))[0]!

  const key = (release: MbReleaseSummary) => [
    release.media.length > 0 && release.media.every((medium) => preferredFormat.test(medium.format ?? '')) ? 0 : 1,
    dateOrder(release.date),
    release.mbid,
  ] as const
  return candidates.filter((release) => release.trackCount === trackCount).sort((a, b) => {
    const [left, right] = [key(a), key(b)]
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
    }
    return 0
  })[0]!
}
