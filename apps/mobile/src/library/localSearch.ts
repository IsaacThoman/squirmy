import { searchKey, type SearchItem } from '@squirmy/client-core';
import type { AlbumSummary, ArtistSummary, PlaylistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';

/**
 * Searching what is on the phone, for when the server can't be asked: the same name matching
 * as the server's library search (`apps/server/src/modules/search/rank.ts`), so results rank
 * as they do online. A whole name beats one that starts with the query, which beats a later
 * word, which beats a typo; an album or song found through its artist reads after names that
 * match themselves, and "radiohead karma" finds Karma Police by artist and title together.
 */

/** What is kept on the phone to search: downloads and the saved library. */
export type LocalLibrary = {
  tracks: readonly TrackSummary[];
  albums: readonly AlbumSummary[];
  artists: readonly ArtistSummary[];
  playlists: readonly PlaylistSummary[];
};

/** The server's relevance scale (rank.ts `relevance`). */
const relevance = {
  exact: 1,
  article: 0.97,
  compact: 0.95,
  wordPrefix: 0.8,
  pairPrefix: 0.75,
  prefix: 0.7,
  typo: 0.65,
  artistExact: 0.62,
  word: 0.6,
  artistPrefix: 0.5,
  artistPartial: 0.45,
} as const;

/** Queries shorter than this never match by a typo: too many names are one edit away. */
const minTypoLength = 5;
/**
 * Everything here is the viewer's own, which the server ranks at least this prominent
 * (rank.ts `ownedFloor`); a heart adds a little, as it does there.
 */
const ownedProminence = 0.55;
const likedBonus = 0.1;
/** What can't play now still lists, lower, as client-core's `mergeSearch` does. */
const unplayablePenalty = 0.7;
const kindOrder: Record<SearchItem['type'], number> = { artist: 0, album: 1, playlist: 2, track: 3 };

const withoutArticle = (key: string) => key.replace(/^(the|a|an) (?=.)/, '');
const compact = (key: string) => key.replaceAll(' ', '');

/** Whether `a` becomes `b` with one character inserted, deleted or replaced, or two neighbours swapped. */
export function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/** Words that name an edition, not the music: "(Deluxe Edition)", "[2011 Remaster]", "(feat. …)" are left off a name too. */
const editionSuffix = /\s*[([](?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]\s*$|\s*[([][^)\]]*\b(?:deluxe|expanded|remaster(?:ed)?|anniversary|bonus|special edition|explicit)\b[^)\]]*[)\]]\s*$/i;

/** The keys a name is matched by: as written, and without a trailing edition or guest credit. */
function forms(name: string): string[] {
  const keys = new Set([searchKey(name), searchKey(name.replace(editionSuffix, ''))]);
  keys.delete('');
  return [...keys];
}

function nameRelevance(query: string, form: string): number {
  if (form === query) return relevance.exact;
  const bareQuery = withoutArticle(query);
  const bare = withoutArticle(form);
  if (bare === bareQuery) return relevance.article;
  if (compact(form) === compact(query)) return relevance.compact;
  if (form.startsWith(`${query} `) || bare.startsWith(`${bareQuery} `)) return relevance.wordPrefix;
  if (form.startsWith(query) || bare.startsWith(bareQuery)) return relevance.prefix;
  if (` ${form}`.includes(` ${query}`)) return relevance.word;
  if ([...query].length >= minTypoLength && (oneEditApart(form, query) || oneEditApart(bare, bareQuery))) return relevance.typo;
  return 0;
}

function artistRelevance(query: string, form: string): number {
  if (form === query || withoutArticle(form) === withoutArticle(query)) return relevance.artistExact;
  if (form.startsWith(`${query} `) || withoutArticle(form).startsWith(`${withoutArticle(query)} `)) return relevance.artistPrefix;
  if (form.startsWith(query) || withoutArticle(form).startsWith(withoutArticle(query))) return relevance.artistPartial;
  return 0;
}

/** "artist title" and "title artist", for a query that names both. */
function pairRelevance(query: string, title: string, artist: string): number {
  let best = 0;
  for (const pair of [`${artist} ${title}`, `${title} ${artist}`]) {
    if (pair === query) return relevance.exact;
    if (withoutArticle(pair) === withoutArticle(query)) best = Math.max(best, relevance.article);
    // Only a query that goes past the first part is about the pair, not the artist or title alone.
    const first = pair.startsWith(artist) ? artist : title;
    if ([...query].length > [...first].length + 1 && pair.startsWith(query)) best = Math.max(best, relevance.pairPrefix);
  }
  return best;
}

/** How well a name, and for an album or song its artists, match `query`: 0 when nothing does. */
export function localMatch(query: string, name: string, artists: readonly string[] | null): number {
  const key = searchKey(query);
  if (!key) return 0;
  const titles = forms(name);
  let best = 0;
  for (const title of titles) best = Math.max(best, nameRelevance(key, title));
  if (artists) {
    for (const artist of new Set(artists.flatMap(forms))) {
      best = Math.max(best, artistRelevance(key, artist));
      for (const title of titles) best = Math.max(best, pairRelevance(key, title, artist));
    }
  }
  return best;
}

const creditNames = (item: { artistCredit: string; artists: readonly { name: string }[] }) => [item.artistCredit, ...item.artists.map(artist => artist.name)];

export type LocalSearchOptions = {
  /** What can't play now (offline: what isn't on the phone) ranks lower. */
  plays: (item: SearchItem) => boolean;
  /** The most of each kind listed. */
  limit?: number;
};

/**
 * Everything in `library` that matches `query`, best first, every kind mixed as the server
 * ranks them: `match × (0.5 + 0.5 × prominence)`, with what can't play now scored down. Each
 * item is listed once, by id, the first copy found.
 */
export function localSearch(query: string, library: LocalLibrary, { plays, limit = 50 }: LocalSearchOptions): SearchItem[] {
  if (!searchKey(query)) return [];
  const scored: { item: SearchItem; score: number; order: number }[] = [];
  const seen = new Set<string>();
  const counts: Record<SearchItem['type'], number> = { artist: 0, album: 0, playlist: 0, track: 0 };
  let order = 0;
  const consider = (item: SearchItem, id: string, match: number, liked: boolean | undefined) => {
    const key = `${item.type}:${id}`;
    if (match <= 0 || seen.has(key)) return;
    seen.add(key);
    const prominence = ownedProminence + (liked ? likedBonus : 0);
    const score = match * (0.5 + 0.5 * prominence) * (plays(item) ? 1 : unplayablePenalty);
    scored.push({ item, score, order: order++ });
  };
  for (const artist of library.artists) consider({ type: 'artist', artist }, artist.id, localMatch(query, artist.name, null), artist.liked);
  for (const album of library.albums) consider({ type: 'album', album }, album.id, localMatch(query, album.title, creditNames(album)), album.liked);
  for (const playlist of library.playlists) consider({ type: 'playlist', playlist }, playlist.id, localMatch(query, playlist.name, null), false);
  for (const track of library.tracks) consider({ type: 'track', track }, track.id, localMatch(query, track.title, creditNames(track)), track.liked);
  scored.sort((a, b) => b.score - a.score || kindOrder[a.item.type] - kindOrder[b.item.type] || a.order - b.order);
  return scored.flatMap(({ item }) => {
    if (counts[item.type] >= limit) return [];
    counts[item.type] += 1;
    return [item];
  });
}

/** Ranked items as one answer of the server's library search, each kind in its order, for the Library's sections. */
export function localResults(items: readonly SearchItem[]): SearchResults {
  return {
    artists: items.flatMap(item => (item.type === 'artist' ? [item.artist] : [])),
    albums: items.flatMap(item => (item.type === 'album' ? [item.album] : [])),
    tracks: items.flatMap(item => (item.type === 'track' ? [item.track] : [])),
    provider: null,
  };
}
