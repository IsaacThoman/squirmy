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

/** A clean or edited pressing is chosen only when no other pressing qualifies (an explicit album page shows the explicit songs). */
const censored = (release: MbReleaseSummary) => /\b(clean|edited|censored)\b/i.test(`${release.disambiguation} ${release.title}`)

/** What identifies the edition a store album is, as far as it is known. */
export type EditionHint = {
  /** The MusicBrainz release the store links to. */
  releaseMbid?: string | null
  /** The store album's UPC or EAN. */
  barcode?: string | null
  /** How many tracks the store album has. */
  trackCount?: number | null
}

const digits = (barcode: string | null | undefined) => barcode?.trim().replace(/^0+/, '') || null

/**
 * The edition an album page shows, from a release group's releases.
 *
 * Without a hint (an album opened as the release group):
 * 1. Only releases of the best status present (official over unknown, promotion, bootleg).
 * 2. Of those, the most common track count, so a deluxe edition or a bonus-track pressing
 *    does not stand for the album (a tie goes to the count with the earliest release).
 * 3. Of those, uncensored before clean or edited pressings, CD or digital releases over
 *    vinyl and cassettes, whose sides split discs oddly; then the earliest date (the
 *    original edition); then the MBID, so the choice is stable.
 *
 * With a hint (a store album identified as part of the group: "SOS Deluxe: LANA", the
 * 3am edition of "Midnights") the edition it names: the release it links to, else the
 * releases with its barcode, else those with its track count, ordered as in step 3. Only
 * when none fits does the group's own choice stand: the page the user opened must keep
 * its songs.
 *
 * Null for a group without releases.
 */
export function chooseCanonicalRelease(releases: readonly MbReleaseSummary[], hint?: EditionHint): MbReleaseSummary | null {
  if (releases.length === 0) return null
  const best = Math.min(...releases.map((release) => statusRank(release.status)))
  const candidates = releases.filter((release) => statusRank(release.status) === best)

  const key = (release: MbReleaseSummary) => [
    censored(release) ? 1 : 0,
    release.media.length > 0 && release.media.every((medium) => preferredFormat.test(medium.format ?? '')) ? 0 : 1,
    dateOrder(release.date),
    release.mbid,
  ] as const
  const first = (list: readonly MbReleaseSummary[]) => [...list].sort((a, b) => {
    const [left, right] = [key(a), key(b)]
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
    }
    return 0
  })[0] ?? null

  if (hint) {
    const linked = hint.releaseMbid ? releases.find((release) => release.mbid === hint.releaseMbid) : undefined
    if (linked) return linked
    const barcode = digits(hint.barcode)
    const pressed = barcode ? releases.filter((release) => digits(release.barcode) === barcode) : []
    if (pressed.length > 0) return first(pressed)
    const counted = hint.trackCount ? releases.filter((release) => release.trackCount === hint.trackCount) : []
    if (counted.length > 0) {
      const status = Math.min(...counted.map((release) => statusRank(release.status)))
      return first(counted.filter((release) => statusRank(release.status) === status))
    }
  }

  const counts = new Map<number, { count: number; earliest: string }>()
  for (const release of candidates) {
    const entry = counts.get(release.trackCount) ?? { count: 0, earliest: '9999' }
    entry.count += 1
    if (dateOrder(release.date) < entry.earliest) entry.earliest = dateOrder(release.date)
    counts.set(release.trackCount, entry)
  }
  const [trackCount] = [...counts].sort(([, a], [, b]) => b.count - a.count || (a.earliest < b.earliest ? -1 : a.earliest > b.earliest ? 1 : 0))[0]!
  return first(candidates.filter((release) => release.trackCount === trackCount))
}
