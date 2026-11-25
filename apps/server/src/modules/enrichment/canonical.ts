import { matchKey } from '../../lib/text.js'
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

/**
 * A release of another mix of the album (Dolby Atmos, spatial or surround audio, an
 * instrumental or a cappella version, a sped-up or slowed one) is chosen only when nothing
 * else qualifies. MusicBrainz lists its songs as recordings of their own with ISRCs of their
 * own, so stores' copies and delivered files, which are the stereo mix, matched none of its
 * tracks: ADÉLA's PRIMA showed the Atmos release with the stereo songs listed again below it.
 */
const otherMix = (release: MbReleaseSummary) =>
  /\b(dolby|atmos|spatial|surround|binaural|360|quadraphonic|5\.1|7\.1|instrumentals?|a ?cappella|acapella|karaoke|sped up|slowed)\b/i
    .test(`${release.disambiguation} ${release.title}`)

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
 * 3. Of those, the album's own mix before another (Dolby Atmos, instrumental), uncensored
 *    before clean or edited pressings, CD or digital releases over vinyl and cassettes,
 *    whose sides split discs oddly; then the earliest date (the original edition); then
 *    the MBID, so the choice is stable.
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
    otherMix(release) ? 1 : 0,
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

/** At most this many editions of one group are kept apart: each costs a MusicBrainz request. */
export const maxNamedEditions = 6

/**
 * A title as the cover prints it, give or take case, spacing, quote marks and dashes:
 * "SO CLOSE TO WHAT???" and "So Close to What" are two titles, "Don’t Stop" and
 * "DON'T STOP" one.
 */
const printedTitle = (title: string) => title.normalize('NFKC').toLocaleLowerCase()
  .replace(/[‘’`´]/gu, "'").replace(/[“”]/gu, '"').replace(/[‐‑‒–—―]/gu, '-').replace(/\s+/gu, ' ').trim()

type Group = { title: string; releases: readonly MbReleaseSummary[] }

/**
 * The release a group's own row shows: `chooseCanonicalRelease` over the releases titled as
 * the group is, when any are, else over all of them. An edition with a title of its own is
 * not the album however many pressings it has: Tate McRae's deluxe "SO CLOSE TO WHAT???"
 * had seven with 21 songs beside eight of "So Close to What" with 13, and one more would
 * have made the album page the deluxe's.
 */
export function standardRelease(group: Group): MbReleaseSummary | null {
  const title = printedTitle(group.title)
  const named = group.releases.filter((release) => printedTitle(release.title) === title)
  return chooseCanonicalRelease(named.length > 0 ? named : group.releases)
}

/**
 * The editions of a release group that have a title of their own: "SO CLOSE TO WHAT???"
 * (the deluxe) in the group of "So Close to What", "Midnights (3am Edition)" in
 * "Midnights". Stores list them as albums of their own; on an album page they are its
 * other versions. One release per title, chosen as the group's own is
 * (`chooseCanonicalRelease` over that title's releases), in order of their dates.
 *
 * Only releases of the group's best status and of the album's own mix, uncensored, count:
 * a clean or Dolby Atmos release is not an edition to show. A title that differs from the
 * standard one only in punctuation counts only when its track count differs too, so a typo
 * on one pressing is not an edition. Pressings under the standard title (a Japanese CD
 * with a bonus track, a store exclusive) are not editions here: no name tells them apart.
 * At most {@link maxNamedEditions}.
 */
export function namedEditions(group: Group): MbReleaseSummary[] {
  const standard = standardRelease(group)
  if (!standard) return []
  const best = Math.min(...group.releases.map((release) => statusRank(release.status)))
  const own = new Set([printedTitle(standard.title), printedTitle(group.title)])
  const byTitle = new Map<string, MbReleaseSummary[]>()
  for (const release of group.releases) {
    if (statusRank(release.status) !== best || otherMix(release) || censored(release) || release.trackCount === 0) continue
    const title = printedTitle(release.title)
    if (own.has(title)) continue
    if (matchKey(release.title) === matchKey(standard.title) && release.trackCount === standard.trackCount) continue
    byTitle.set(title, [...(byTitle.get(title) ?? []), release])
  }
  return [...byTitle.values()]
    .map((releases) => chooseCanonicalRelease(releases)!)
    .sort((a, b) => (dateOrder(a.date) < dateOrder(b.date) ? -1 : dateOrder(a.date) > dateOrder(b.date) ? 1 : a.mbid < b.mbid ? -1 : 1))
    .slice(0, maxNamedEditions)
}
