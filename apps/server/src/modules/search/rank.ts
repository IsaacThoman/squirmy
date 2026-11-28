/**
 * One list of search results, every kind mixed, best first (`SearchResults.ranked`), and
 * the top result taken from it.
 *
 * A result's score is how well its name matches the query, scaled by how prominent it is:
 *
 *   score = relevance × (0.5 + 0.5 × prominence)
 *
 * Relevance runs from 1 (the whole name) down through a leading-word prefix (0.8), any
 * prefix (0.7), one typo (0.65: the provider's own first answer to "radiohed" is the band, not
 * a song called that), a later word (0.6) and the artist of an album or song (0.62 to 0.45),
 * to 0.3 for what the search found for reasons of its own (a provider's fuzzy
 * match). Prominence is 0..1: the provider's measure (Deezer fans on a log scale, a song's
 * rank, the local index's popularity), passed from songs to their album and from artists
 * to their albums and songs, raised for what is in the viewer's library and what they
 * play and like. Unknown prominence falls back to the result's place in its own list,
 * since every source already orders by it.
 *
 * The scale is what makes an exact name lose to a far more prominent prefix: for "tate",
 * Tate McRae (prefix, 0.8, two million fans) scores 0.75 and the artist named TATE (exact,
 * a few thousand fans) 0.65. Prominence can at most double a score, so between results of
 * similar prominence the better match wins (an exact name loses to a prefix match only
 * about a hundred times better known), and a famous artist's songs, found through the
 * start of the artist's name alone (relevance 0.5), score at most 0.5, so they never bury
 * another artist named exactly as typed.
 */
import type { AlbumType, SearchKind, SearchRanked, SearchTopResult } from '@squirmy/contracts'
import { matchKey } from '../../lib/text.js'
import { editionFreeKey } from './keys.js'

export type RankInput = {
  type: SearchKind
  id: string
  /** The artist's name, the album's or song's title. */
  name: string
  /** Album and song credits as written, and each credited artist's name. */
  artistCredit: string | null
  artistNames: string[]
  /** For prominence passed along: the credited artists, a song's album. */
  artistIds: string[]
  albumId: string | null
  albumTitle?: string | null
  /** An album's type: a single gives way to the song of the same name. */
  albumType?: AlbumType | null
  /** The result's place in the list it came from. */
  position: number
}

export type RankSignals = {
  /** 0..1, from the provider or stored, by id. */
  popularity: ReadonlyMap<string, number>
  /** Ids in the viewer's library. */
  owned: ReadonlySet<string>
  /** Plays among the viewer's recent ones, by id. */
  plays: ReadonlyMap<string, number>
  liked: ReadonlySet<string>
}

export type Ranked = SearchRanked & {
  /** How well the name alone (or artist and title together) matches, 0 when only the artist or nothing does. */
  nameMatch: number
}

export const relevance = {
  exact: 1,
  /** The whole name once a leading article is ignored. Artist and title together count as the whole name. */
  article: 0.97,
  /** The same letters and digits with spacing and punctuation ignored: "acdc" for AC/DC, "tate" for T.A.T.E. */
  compact: 0.95,
  /** The name starts with the query's whole words: "tate" in "Tate McRae". */
  wordPrefix: 0.8,
  /** Artist and title together, the last word still being typed. */
  pairPrefix: 0.75,
  prefix: 0.7,
  /** A later word of the name starts with the query: "strokes" in "Is This It (The Strokes)". */
  word: 0.6,
  artistExact: 0.62,
  artistPrefix: 0.5,
  /** One letter wrong, missing, extra, or two swapped, from five characters. */
  typo: 0.65,
  artistPartial: 0.45,
  /** Found by the search for reasons of its own, such as a provider's fuzzy match. */
  found: 0.3,
} as const

/** Queries shorter than this never match by a typo: too many names are one edit away. */
const minTypoLength = 5
const ownedFloor = 0.55
const kindOrder = { artist: 0, album: 1, track: 2 } as const

const withoutArticle = (key: string) => key.replace(/^(the|a|an) (?=.)/, '')
const compact = (key: string) => key.replaceAll(' ', '')

/**
 * Whether `a` becomes `b` with at most one inserted, deleted or replaced character, or two
 * neighbours swapped ("swfit" for "swift").
 */
export function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)
}

/**
 * The keys a name is matched by: as written, without an edition suffix ("(Remastered
 * 2009)"), with letters some names spell with symbols read as those letters ("$uicideboy$",
 * "P!nk"), and for a name of symbols alone ("!!!") the symbols themselves.
 */
function forms(name: string): string[] {
  const keys = new Set([matchKey(name), editionFreeKey(name)])
  if (/[$!]/.test(name)) keys.add(matchKey(name.replaceAll('$', 's').replace(/(?<=\p{L})!(?=\p{L})/gu, 'i')))
  keys.delete('')
  if (keys.size === 0) keys.add(symbolKey(name))
  keys.delete('')
  return [...keys]
}

/** A query or name with no letters or digits, as typed: what `matchKey` would empty. */
const symbolKey = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

/** The key a query is compared by. */
export const queryKey = (query: string) => matchKey(query) || symbolKey(query)

/** How well one name matches the query key. */
function nameRelevance(query: string, form: string): number {
  if (form === query) return relevance.exact
  const bareQuery = withoutArticle(query)
  const bare = withoutArticle(form)
  if (bare === bareQuery) return relevance.article
  if (compact(form) === compact(query)) return relevance.compact
  if (form.startsWith(`${query} `) || bare.startsWith(`${bareQuery} `)) return relevance.wordPrefix
  if (form.startsWith(query) || bare.startsWith(bareQuery)) return relevance.prefix
  if (` ${form}`.includes(` ${query}`)) return relevance.word
  if ([...query].length >= minTypoLength && (oneEditApart(form, query) || oneEditApart(bare, bareQuery))) return relevance.typo
  return 0
}

/** How well a credited artist's name matches the query, for an album or song by them. */
function artistRelevance(query: string, form: string): number {
  if (form === query || withoutArticle(form) === withoutArticle(query)) return relevance.artistExact
  if (form.startsWith(`${query} `) || withoutArticle(form).startsWith(`${withoutArticle(query)} `)) return relevance.artistPrefix
  if (form.startsWith(query) || withoutArticle(form).startsWith(withoutArticle(query))) return relevance.artistPartial
  return 0
}

/** Matches of a title and a credited artist or release title, in either order. */
function pairRelevance(query: string, title: string, context: string): number {
  let best = 0
  for (const [first, second] of [[context, title], [title, context]] as const) {
    const pair = `${first} ${second}`
    if (pair === query) return relevance.exact
    const bareFirst = withoutArticle(first)
    const barePair = `${bareFirst} ${withoutArticle(second)}`
    const bareQuery = withoutArticle(query)
    if (barePair === bareQuery) best = Math.max(best, relevance.article)
    // Only a query that goes past the first part is about the pair, not the artist or title alone.
    if ((query.length > first.length + 1 && pair.startsWith(query))
      || (bareQuery.length > bareFirst.length + 1 && barePair.startsWith(bareQuery))) best = Math.max(best, relevance.pairPrefix)
  }
  return best
}

export function matchOf(query: string, item: Pick<RankInput, 'type' | 'name' | 'artistCredit' | 'artistNames' | 'albumTitle'>): { name: number; total: number } {
  const key = queryKey(query)
  const titles = forms(item.name)
  let name = 0
  for (const form of titles) name = Math.max(name, nameRelevance(key, form))
  let total = name
  if (item.type !== 'artist') {
    const artists = [...new Set([item.artistCredit ?? '', ...item.artistNames].flatMap(forms))]
    for (const artist of artists) {
      total = Math.max(total, artistRelevance(key, artist))
      for (const title of titles) name = Math.max(name, pairRelevance(key, title, artist))
    }
    for (const album of forms(item.albumTitle ?? '')) {
      for (const title of titles) name = Math.max(name, pairRelevance(key, title, album))
    }
    total = Math.max(total, name)
  }
  return { name, total: total || relevance.found }
}

/** The fallback for a result nothing measures: lower the further down its own list. */
const positional = (position: number) => Math.max(0.1, 0.3 - 0.02 * position)

/**
 * Each result's 0..1 prominence. A song passes its own to its album (an album is at least
 * as known as its best known song found), an artist passes most of its own to its albums
 * and songs, and the viewer's library and listening raise it.
 */
function prominence(items: readonly RankInput[], signals: RankSignals): Map<string, number> {
  const known = (id: string) => signals.popularity.get(id) ?? null
  const fromTracks = new Map<string, number>()
  for (const item of items) {
    if (item.type !== 'track') continue
    const own = known(item.id)
    if (own === null) continue
    if (item.albumId) fromTracks.set(item.albumId, Math.max(own, fromTracks.get(item.albumId) ?? 0))
    for (const artistId of item.artistIds) fromTracks.set(artistId, Math.max(own * 0.8, fromTracks.get(artistId) ?? 0))
  }
  const artistPopularity = (ids: string[]) => Math.max(-1, ...ids.map((id) => known(id) ?? -1))

  const result = new Map<string, number>()
  for (const item of items) {
    const candidates = [known(item.id), fromTracks.get(item.id) ?? null]
    if (item.type !== 'artist') {
      const artist = artistPopularity(item.artistIds)
      if (artist >= 0) candidates.push(artist * (item.type === 'album' ? 0.9 : 0.8))
    }
    const measured = candidates.filter((value): value is number => value !== null)
    let value = measured.length > 0 ? Math.max(...measured) : positional(item.position)
    if (signals.owned.has(item.id)) value = Math.max(value, ownedFloor)
    const plays = signals.plays.get(item.id) ?? 0
    if (plays > 0) value = Math.max(value, Math.min(1, ownedFloor + 0.05 * plays))
    if (signals.liked.has(item.id)) value = Math.min(1, value + 0.1)
    result.set(item.id, Math.min(1, Math.max(0, value)))
  }
  return result
}

/** Every result, best first. An id listed twice (as one kind) counts once, at its best. */
export function rank(query: string, items: readonly RankInput[], signals: RankSignals): Ranked[] {
  const prominent = prominence(items, signals)
  const scored = new Map<string, Ranked & { position: number }>()
  for (const item of items) {
    const match = matchOf(query, item)
    // A single shares its name and its listeners with its song, which is what is asked for.
    const single = item.type === 'album' && item.albumType === 'single' ? 0.98 : 1
    const score = Math.min(1, match.total * (0.5 + 0.5 * prominent.get(item.id)!) * single)
    const key = `${item.type}:${item.id}`
    const before = scored.get(key)
    if (!before || score > before.score) {
      scored.set(key, { type: item.type, id: item.id, score: Math.round(score * 10_000) / 10_000, nameMatch: match.name, position: item.position })
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || kindOrder[a.type] - kindOrder[b.type] || a.position - b.position)
    .map(({ position: _position, ...ranked }) => ranked)
}

/**
 * The top result: the best ranked whose own name matches at least by a later word or a typo, so a result
 * found only through its artist or a provider's fuzzy match never leads. Its `score` is the
 * contract's 1..3 for older clients: 3 the whole name as typed, 2 the whole name once an
 * article or spacing is ignored, 1 anything less.
 */
export function topOf(ranked: readonly Ranked[]): SearchTopResult | null {
  const top = ranked.find((item) => item.nameMatch >= Math.min(relevance.typo, relevance.word))
  if (!top) return null
  const score = top.nameMatch >= relevance.exact ? 3 : top.nameMatch >= relevance.compact ? 2 : 1
  return { type: top.type, id: top.id, score }
}
