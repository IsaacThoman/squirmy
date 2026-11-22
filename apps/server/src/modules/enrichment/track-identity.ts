/**
 * Which track of one album a track from another source is.
 *
 * MusicBrainz, Deezer and a delivered file's tags each describe an album's songs with ids
 * of their own, and they disagree more than one would hope: one master carries a label's
 * ISRC on one side and a distributor's on the other, a Dolby Atmos or a clean pressing has
 * codes of its own, titles differ in case and quotes ("I'm The Man", "I’m the Man"), and
 * lengths are rounded differently. Within one album a song is the same track when, in
 * this order, the first step that finds anything finds exactly one:
 *
 * 1. it shares an ISRC, and unless `isrcAlone`, a title or a place too, with lengths
 *    within fifteen seconds (one code on two versions of a song is a data error: Os
 *    Mutantes' 1968 "Baby" and the 1971 one share one on Deezer);
 * 2. it has the same title (`editionFreeKey`: case, quotes, punctuation, guest credits and
 *    edition suffixes aside) and a length within five seconds (at the same place, which
 *    wins over the rest of this step, an unknown length will do), anywhere when neither
 *    carries an ISRC the other lacks entirely (two codes and no place in common are a live
 *    take or a re-recording of the title);
 * 3. it sits at the same place with a length within two seconds, neither title names a
 *    version the other does not ("(Live)", "(Remix)", "(Instrumental)"), and the track
 *    there is not named anywhere on the incoming track lists (`titles`): a deluxe edition
 *    in another order puts other songs of a like length at the same places ("FEEL." and
 *    "LOVE." on DAMN.'s collector's edition).

 * A place is a disc and a position. Tracks with no place (a file filed under the album
 * with no track, a search stub) only match on steps 1 and 2.
 */
import { matchKey } from '../../lib/text.js'
import { editionFreeKey } from '../search/keys.js'

/** Two copies of one song differ in length by at most this. */
export const lengthToleranceMs = 5000
/** With only the place in common, the lengths must agree this closely. */
const placeToleranceMs = 2000
/** With a shared ISRC that does not count alone, the lengths may still differ this much (a fade, a store's rounding). */
const isrcToleranceMs = 15_000

export type IdentifyOptions = {
  /** A shared ISRC is enough on its own (a source's code against rows without files). */
  isrcAlone?: boolean
  /** `editionFreeKey` of every title on the incoming track lists, for step 3. */
  titles?: ReadonlySet<string>
}

export type TrackRef = {
  id: string
  title: string
  isrcs: readonly string[]
  durationMs: number | null
  disc: number | null
  position: number | null
}

const versionWords = /\b(live|remix|mix|demo|acoustic|instrumental|karaoke|acapella|cappella|reprise|edit|session|unplugged|orchestral|version)\b/g

function versionsOf(title: string): string {
  return [...new Set(matchKey(title).match(versionWords) ?? [])].sort().join(' ')
}

const upper = (isrcs: readonly string[]) => isrcs.map((isrc) => isrc.toUpperCase())

function sharesIsrc(a: TrackRef, b: TrackRef): boolean {
  const theirs = new Set(upper(b.isrcs))
  return upper(a.isrcs).some((isrc) => theirs.has(isrc))
}

const samePlace = (a: TrackRef, b: TrackRef) => a.disc !== null && a.position !== null && a.disc === b.disc && a.position === b.position
const closeLength = (a: TrackRef, b: TrackRef, tolerance = lengthToleranceMs) => a.durationMs !== null && b.durationMs !== null && Math.abs(a.durationMs - b.durationMs) <= tolerance
const sameTitle = (a: TrackRef, b: TrackRef) => {
  const key = editionFreeKey(a.title)
  return key !== '' && key === editionFreeKey(b.title)
}

/**
 * The tracks of `among` that `track` is, at the first step (see the module comment) that
 * finds any. Several means the evidence does not tell them apart.
 */
export function trackCandidates(track: TrackRef, among: readonly TrackRef[], { isrcAlone = false, titles }: IdentifyOptions = {}): TrackRef[] {
  const others = among.filter((other) => other.id !== track.id)
  const lengthsAgree = (other: TrackRef, tolerance: number) => track.durationMs === null || other.durationMs === null || closeLength(track, other, tolerance)
  const byIsrc = others.filter((other) => sharesIsrc(track, other)
    && (isrcAlone || ((sameTitle(track, other) || samePlace(track, other)) && lengthsAgree(other, isrcToleranceMs))))
  if (byIsrc.length > 0) return byIsrc
  const byTitle = others.filter((other) => sameTitle(track, other) && (samePlace(track, other)
    ? lengthsAgree(other, lengthToleranceMs)
    : closeLength(track, other) && (track.isrcs.length === 0 || other.isrcs.length === 0 || sharesIsrc(track, other))))
  // The same title twice ("Intro" on two discs): the one at the same place, when one is.
  const placed = byTitle.filter((other) => samePlace(track, other))
  if (byTitle.length > 0) return placed.length > 0 ? placed : byTitle
  return others.filter((other) => samePlace(track, other) && closeLength(track, other, placeToleranceMs)
    && versionsOf(track.title) === versionsOf(other.title) && !titles?.has(editionFreeKey(other.title)))
}

/** The one track of `among` that `track` is, or null when none or several qualify. */
export function identifyTrack(track: TrackRef, among: readonly TrackRef[], options: IdentifyOptions = {}): TrackRef | null {
  const found = trackCandidates(track, among, options)
  const ids = new Set(found.map((one) => one.id))
  return ids.size === 1 ? found[0]! : null
}
