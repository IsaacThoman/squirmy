/**
 * `SearchResults.top`: the one result a client can lead with, so an album found by its
 * exact title is not shown below songs that only share a word with it.
 */
import type { SearchResults, SearchTopResult } from '@squirmy/contracts'
import { inArray } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordings } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'
import { editionFreeKey } from './keys.js'

type Found = Pick<SearchResults, 'artists' | 'albums' | 'tracks'>

/** The key without a leading article, so "money store" is "The Money Store". */
const withoutArticle = (key: string) => key.replace(/^(the|a|an) (?=.)/, '')

/** Whether `a` becomes `b` with at most one inserted, deleted or replaced character. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)
}

/** Queries shorter than this never match by a typo: too many names are one edit away. */
const minTypoLength = 5

type Match = {
  /** 3 for the whole name, also once edition suffixes are dropped; 1 when it starts with the query; 0.5 for one typo; 0 otherwise. */
  tier: number
  /** Matched with its article as typed ("the money store" is not literally "Money Store"). */
  literal: boolean
}

/**
 * How exactly any of `names` matches the query key. A leading article is ignored on both
 * sides, and an edition suffix ("(Remastered 2009)") on the name: Deezer names most
 * classic albums that way, and the plain title from someone else must not beat them.
 */
function exactness(query: string, names: string[]): Match {
  const bare = withoutArticle(query)
  let best: Match = { tier: 0, literal: false }
  const consider = (tier: number, literal: boolean) => {
    if (tier > best.tier || (tier === best.tier && literal && !best.literal)) best = { tier, literal }
  }
  for (const name of names) {
    const key = matchKey(name)
    const forms = [key, editionFreeKey(name)]
    if (forms.includes(query)) consider(3, true)
    else if (forms.some((form) => withoutArticle(form) === bare)) consider(3, false)
    else if (forms.some((form) => form.startsWith(query))) consider(1, true)
    else if (forms.some((form) => withoutArticle(form).startsWith(bare))) consider(1, false)
    else if ([...query].length >= minTypoLength && forms.some((form) => oneEditApart(form, query) || oneEditApart(withoutArticle(form), bare))) consider(0.5, false)
  }
  return best
}

/** The title alone, and with its artist on either side ("radiohead ok computer"). */
const withArtist = (title: string, artist: string) => [title, `${artist} ${title}`, `${title} ${artist}`]

const kindOrder = { artist: 0, album: 1, track: 2 } as const

type Candidate = Match & {
  type: 'artist' | 'album' | 'track'
  id: string
  /** 0..1, or null when nothing returned says how popular it is. */
  popularity: number | null
  /** Its place in its own list: the provider's (or the library's) ranking. */
  position: number
}

/**
 * Whether `a` should lead rather than `b`: the better match; then the one matching the
 * article as typed; then, when both popularities are known, the more popular; then the one
 * its list ranks higher (the provider already ranks by popularity, and an album's
 * popularity is unknown when none of its tracks came back); then artist before album
 * before track.
 */
function better(a: Candidate, b: Candidate): boolean {
  if (a.tier !== b.tier) return a.tier > b.tier
  if (a.literal !== b.literal) return a.literal
  if (a.popularity !== null && b.popularity !== null && a.popularity !== b.popularity) return a.popularity > b.popularity
  if (a.position !== b.position) return a.position < b.position
  return kindOrder[a.type] < kindOrder[b.type]
}

/**
 * `SearchTopResult.score`: the match as the 1..3 a client compares across the library's and
 * the catalog's top results, which are picked separately. It follows `better`'s first two
 * keys, so a higher score always means a hint this ranking would have put first: 3 the
 * whole name as typed (edition suffixes ignored, so the remaster and the plain title tie
 * as they do here), 2 the whole name only once a leading article is ignored, 1 a prefix or
 * one typo. Prefix and typo share 1 because the contract has no lower step.
 */
function score(match: Match): 1 | 2 | 3 {
  if (match.tier === 3) return match.literal ? 3 : 2
  return 1
}

/**
 * Picks the result that matches the query best (see `better`). A track's popularity is
 * its own; an album's or artist's is the best of the returned tracks on it or by them.
 * Null when nothing matches at least as a prefix or one typo away.
 */
export async function topResult(query: string, found: Found): Promise<SearchTopResult | null> {
  const key = matchKey(query)
  const trackIds = found.tracks.map((track) => track.id)
  const rows = trackIds.length > 0
    ? await db.select({ id: recordings.id, popularity: recordings.popularity }).from(recordings).where(inArray(recordings.id, trackIds))
    : []
  const trackPopularity = new Map(rows.flatMap((row) => (row.popularity === null ? [] : [[row.id, row.popularity] as const])))
  const best = (tracks: Found['tracks']) => {
    const known = tracks.flatMap((track) => (trackPopularity.has(track.id) ? [trackPopularity.get(track.id)!] : []))
    return known.length > 0 ? Math.max(...known) : null
  }

  const candidates: Candidate[] = [
    ...found.artists.map((artist, position) => ({
      type: 'artist' as const,
      id: artist.id,
      position,
      ...exactness(key, [artist.name]),
      popularity: best(found.tracks.filter((track) => track.artists.some((credit) => credit.id === artist.id))),
    })),
    ...found.albums.map((album, position) => ({
      type: 'album' as const,
      id: album.id,
      position,
      ...exactness(key, withArtist(album.title, album.artistCredit)),
      popularity: best(found.tracks.filter((track) => track.album?.id === album.id)),
    })),
    ...found.tracks.map((track, position) => ({
      type: 'track' as const,
      id: track.id,
      position,
      ...exactness(key, withArtist(track.title, track.artistCredit)),
      popularity: trackPopularity.get(track.id) ?? null,
    })),
  ]
  let top: Candidate | undefined
  for (const candidate of candidates) {
    if (candidate.tier === 0) continue
    if (!top || better(candidate, top)) top = candidate
  }
  return top ? { type: top.type, id: top.id, score: score(top) } : null
}
