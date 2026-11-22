import type { AlbumSummary, ArtistSummary, PlaylistSummary, SearchKind, SearchResults, SearchTopResult, TrackSummary } from '@squirmy/contracts'
import { albumPresentation, isPlayable, type Viewer } from './availability.js'

/** The result to lead with, carrying the item it names. */
export type SearchTop =
  | { type: 'artist'; artist: ArtistSummary }
  | { type: 'album'; album: AlbumSummary }
  | { type: 'track'; track: TrackSummary }

/** One row of the single list a search shows, every kind mixed. Playlists are the viewer's own, matched on the device. */
export type SearchItem =
  | { type: 'artist'; artist: ArtistSummary }
  | { type: 'album'; album: AlbumSummary }
  | { type: 'track'; track: TrackSummary }
  | { type: 'playlist'; playlist: PlaylistSummary }

export type SearchItemType = SearchItem['type']

/** One result set for a query: the ranked list, the top result, and each kind in display order. */
export type MergedSearch = {
  /** Every result, best first, all kinds mixed. */
  items: SearchItem[]
  top: SearchTop | null
  artists: ArtistSummary[]
  albums: AlbumSummary[]
  tracks: TrackSummary[]
}

type Answer = Pick<SearchResults, 'artists' | 'albums' | 'tracks' | 'top' | 'ranked'>

export type MergeOptions = {
  /** What was typed: orders an older server's answers, which carry no ranking, by how well names match. */
  query?: string
  /** The viewer's playlists, listed among the results when their name matches `query`. */
  playlists?: { query: string; items: readonly PlaylistSummary[] }
}

/** A stable key for a row, unique across kinds. */
export const searchItemKey = (item: SearchItem) => `${item.type}:${itemId(item)}`

export function itemId(item: SearchItem): string {
  switch (item.type) {
    case 'artist': return item.artist.id
    case 'album': return item.album.id
    case 'track': return item.track.id
    case 'playlist': return item.playlist.id
  }
}

/** What the viewer cannot play still lists, lower: search covers all music, but what plays should come first. */
const unplayablePenalty = 0.7

/**
 * Merges `/search/library` and `/search/catalog` into one result set. Either may be null
 * while it loads.
 *
 * `items` is the list a client shows: every result ordered by the servers' `ranked`
 * scores, which are on one scale across both answers (an item named twice takes its
 * higher score), with what the viewer cannot play scored down. Items an older server did
 * not rank follow, the top result first, then artists, albums and songs.
 *
 * The per-kind lists keep the library's rows first in their order with the catalog's
 * appended after them, minus those already listed, and what the viewer cannot play last
 * among the appended. Identical entities under different ids (the same album twice) are
 * listed once, the first seen.
 *
 * The top result is the better-scored of the two hints, the library's on a tie. Without
 * scores (an older server) the library's hint wins, else the catalog's. A hint that names
 * nothing in the lists is ignored.
 */
export function mergeSearch(
  library: Answer | null | undefined, catalog: Answer | null | undefined, viewer: Viewer | null | undefined, options: MergeOptions = {},
): MergedSearch {
  const albumPlays = (album: AlbumSummary) => albumPresentation(album, viewer) === 'normal'
  const trackPlays = (track: TrackSummary) => isPlayable(track, viewer)
  const merged: MergedSearch = {
    items: [],
    top: null,
    artists: append(library?.artists, catalog?.artists, () => true, () => null),
    albums: append(library?.albums, catalog?.albums, albumPlays, albumIdentity),
    tracks: append(library?.tracks, catalog?.tracks, trackPlays, trackIdentity),
  }
  const fromLibrary = find(merged, library?.top)
  const fromCatalog = find(merged, catalog?.top)
  const catalogWins = fromCatalog && (!fromLibrary || (catalog?.top?.score ?? 0) > (library?.top?.score ?? Infinity))
  merged.top = (catalogWins ? fromCatalog : fromLibrary) ?? null
  merged.items = rankItems(merged, [library?.ranked, catalog?.ranked], { albumPlays, trackPlays }, options)
  return merged
}

function rankItems(
  merged: MergedSearch,
  rankings: (Answer['ranked'] | undefined)[],
  plays: { albumPlays: (album: AlbumSummary) => boolean; trackPlays: (track: TrackSummary) => boolean },
  options: MergeOptions,
): SearchItem[] {
  const byKey = new Map<string, SearchItem>()
  for (const artist of merged.artists) byKey.set(`artist:${artist.id}`, { type: 'artist', artist })
  for (const album of merged.albums) byKey.set(`album:${album.id}`, { type: 'album', album })
  for (const track of merged.tracks) byKey.set(`track:${track.id}`, { type: 'track', track })

  const scores = new Map<string, number>()
  for (const ranked of rankings) {
    for (const entry of ranked ?? []) {
      const key = `${entry.type}:${entry.id}`
      if (byKey.has(key)) scores.set(key, Math.max(entry.score, scores.get(key) ?? 0))
    }
  }
  const scored = [...scores].map(([key, score]) => {
    const item = byKey.get(key)!
    const playable = item.type === 'album' ? plays.albumPlays(item.album) : item.type === 'track' ? plays.trackPlays(item.track) : true
    return { item, score: playable ? score : score * unplayablePenalty }
  })
  if (options.playlists) {
    for (const playlist of options.playlists.items) {
      const score = playlistScore(options.playlists.query, playlist.name)
      if (score > 0) scored.push({ item: { type: 'playlist', playlist }, score })
    }
  }
  // A stable sort keeps each answer's own order between equal scores.
  scored.sort((a, b) => b.score - a.score)

  // What no ranking named (an older server): the top result, then the rest by how well their
  // names match what was typed, else artists, albums and songs in their lists' order.
  const listed = new Set(scored.map(({ item }) => searchItemKey(item)))
  const rest: SearchItem[] = []
  const topKey = merged.top && `${merged.top.type}:${topId(merged.top)}`
  for (const [key, item] of byKey) if (!listed.has(key) && key !== topKey) rest.push(item)
  if (options.query) {
    const query = options.query
    const position = new Map(rest.map((item, index) => [item, index]))
    const match = new Map(rest.map(item => [item, nameMatch(query, item)]))
    rest.sort((a, b) => match.get(b)! - match.get(a)! || position.get(a)! - position.get(b)!)
  }
  if (topKey && !listed.has(topKey)) rest.unshift(byKey.get(topKey)!)
  return [...scored.map(({ item }) => item), ...rest]
}

/** How well a name matches, on the server's relevance scale (rank.ts) without its prominence. */
function nameMatch(query: string, item: SearchItem): number {
  const own = textMatch(query, item.type === 'artist' ? item.artist.name : item.type === 'album' ? item.album.title : item.type === 'track' ? item.track.title : item.playlist.name)
  const credit = item.type === 'album' ? item.album.artistCredit : item.type === 'track' ? item.track.artistCredit : null
  // A name found through its artist reads after names that match themselves.
  return Math.max(own, credit === null ? 0 : textMatch(query, credit) * 0.62)
}

function textMatch(query: string, name: string): number {
  const q = searchKey(query)
  const key = searchKey(name)
  if (!q || !key) return 0
  const bare = (text: string) => text.replace(/^(the|a|an) (?=.)/, '')
  if (key === q) return 1
  if (bare(key) === bare(q) || key.replaceAll(' ', '') === q.replaceAll(' ', '')) return 0.97
  if (key.startsWith(`${q} `)) return 0.8
  if (key.startsWith(q) || bare(key).startsWith(bare(q))) return 0.7
  return ` ${key}`.includes(` ${q}`) ? 0.6 : 0
}

const topId = (top: SearchTop) => (top.type === 'artist' ? top.artist.id : top.type === 'album' ? top.album.id : top.track.id)

/**
 * Text for matching as the server's `matchKey` does: case, diacritics and punctuation
 * ignored, "&" read as "and".
 */
export function searchKey(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

/**
 * A playlist's place among the server's results: its name's match on the server's scale
 * (rank.ts), at the prominence of something in the viewer's library. Zero when the name
 * does not match: the whole name, its start, or the start of a later word.
 */
export function playlistScore(query: string, name: string): number {
  return textMatch(query, name) * (0.5 + 0.5 * 0.55)
}

/** The same album listed twice under different ids: one title, credit, type and year. */
function albumIdentity(album: AlbumSummary): string {
  return [searchKey(album.title), searchKey(album.artistCredit), album.type, album.year ?? ''].join('|')
}

/** The same song listed twice under different ids: one title, credit and album, about one length. */
function trackIdentity(track: TrackSummary): string {
  // Lengths are rounded to five seconds, so a few hundred milliseconds between two copies do not split them.
  return [searchKey(track.title), searchKey(track.artistCredit), searchKey(track.album?.title ?? ''), Math.round(track.durationMs / 5000)].join('|')
}

function append<T extends { id: string }>(
  first: readonly T[] | undefined, rest: readonly T[] | undefined, playable: (item: T) => boolean, identity: (item: T) => string | null,
): T[] {
  const seen = new Set<string>()
  const keep = (item: T) => {
    const same = identity(item)
    if (seen.has(item.id) || (same !== null && seen.has(same))) return false
    seen.add(item.id)
    if (same !== null) seen.add(same)
    return true
  }
  const head = (first ?? []).filter(keep)
  const tail = (rest ?? []).filter(keep)
  return [...head, ...tail.filter(playable), ...tail.filter(item => !playable(item))]
}

function find(merged: MergedSearch, hint: SearchTopResult | null | undefined): SearchTop | null {
  if (!hint) return null
  if (hint.type === 'artist') {
    const artist = merged.artists.find(item => item.id === hint.id)
    return artist ? { type: 'artist', artist } : null
  }
  if (hint.type === 'album') {
    const album = merged.albums.find(item => item.id === hint.id)
    return album ? { type: 'album', album } : null
  }
  const track = merged.tracks.find(item => item.id === hint.id)
  return track ? { type: 'track', track } : null
}

/** The kinds a client's filter offers, in its order. `all` is the mixed list. */
export const searchFilters = ['all', 'track', 'album', 'artist', 'playlist'] as const
export type SearchFilter = (typeof searchFilters)[number]

/** The server's kind for a filter that pages through one, else null. */
export const filterKind = (filter: SearchFilter): SearchKind | null => (filter === 'all' || filter === 'playlist' ? null : filter)

/**
 * The songs to queue when one song of a result list is played: that song, then the other
 * playable songs of the list in order, so playing on continues through what was found.
 * Returns the tracks and where the chosen song is among them.
 */
export function searchQueue(items: readonly SearchItem[], chosen: TrackSummary, playable: (track: TrackSummary) => boolean): { tracks: TrackSummary[]; start: number } {
  const tracks = items.flatMap(item => (item.type === 'track' && (item.track.id === chosen.id || playable(item.track)) ? [item.track] : []))
  const start = tracks.findIndex(track => track.id === chosen.id)
  return start < 0 ? { tracks: [chosen], start: 0 } : { tracks, start }
}
