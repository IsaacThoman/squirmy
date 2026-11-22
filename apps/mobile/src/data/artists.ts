import type { AlbumSummary, AlbumType, ArtistDetail, ArtistSummary } from '@squirmy/contracts';
import { findCached } from './albums';

/** How often an artist page the server is still filling in (`detailPending`) is asked for again, and how many times. */
export const pendingArtistPollMs = 3000;
const pendingArtistPolls = 40;

function isArtistSummary(value: object, id: string): value is ArtistSummary {
  // An album or a track has an `artistCredit`; an artist is the object with this id and none.
  return (value as { id?: unknown }).id === id && 'name' in value && 'image' in value && !('artistCredit' in value);
}

/**
 * The artist as a list already on the phone showed it (a search result, Home, a library
 * page, an album's credits), so the page can draw its header at once; the first answer for
 * an artist the server has not filled in yet takes seconds.
 */
export function findArtistSummary(cached: readonly unknown[], id: string): ArtistSummary | undefined {
  return findCached(cached, (value): value is ArtistSummary => isArtistSummary(value, id));
}

/** An artist page to show while the real one loads: the summary, with nothing under it yet. */
export function artistPlaceholder(artist: ArtistSummary): ArtistDetail {
  return {
    ...artist, sortName: null, disambiguation: null, bio: null, bioUrl: null, genres: [], liked: false,
    topTracks: [], albums: [], similar: [],
  };
}

/** Whether to ask again for an artist page the server said it is still filling in. */
export function artistPending(artist: ArtistDetail | undefined, answers: number): boolean {
  return Boolean(artist?.detailPending) && answers <= pendingArtistPolls;
}

/** One heading of an artist's discography: its releases of some types, or those of other artists that credit them. */
export type ReleaseGroup = { key: string; title: string; albums: readonly AlbumSummary[] };

/**
 * Discography headings on an artist page, in order. EPs and singles share a rail, as on
 * Apple Music; soundtracks and other releases keep their own, apart from compilations.
 */
const groups: { key: string; title: string; types: readonly AlbumType[] }[] = [
  { key: 'albums', title: 'Albums', types: ['album'] },
  { key: 'singles', title: 'EPs & Singles', types: ['ep', 'single'] },
  { key: 'compilations', title: 'Compilations', types: ['compilation'] },
  { key: 'live', title: 'Live Albums', types: ['live'] },
  { key: 'soundtracks', title: 'Soundtracks', types: ['soundtrack'] },
  { key: 'other', title: 'Other Releases', types: ['other'] },
];
export const appearsOnKey = 'appears-on';

/** The artist's releases under their headings, empty headings left out. */
export function releaseGroups(artist: Pick<ArtistDetail, 'albums' | 'appearsOn'>): ReleaseGroup[] {
  // Filtered from the one list, so each heading keeps the server's newest-first order across its types.
  return [
    ...groups.map(group => ({ key: group.key, title: group.title, albums: artist.albums.filter(album => group.types.includes(album.type)) })),
    { key: appearsOnKey, title: 'Appears On', albums: artist.appearsOn ?? [] },
  ].filter(group => group.albums.length);
}
