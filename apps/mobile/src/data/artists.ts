import { ARTIST_SECTION_KEYS, type AlbumSummary, type AlbumType, type ArtistDetail, type ArtistSectionKey, type ArtistSummary } from '@squirmy/contracts';
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

/**
 * One heading of an artist's discography. `albums` is what the page shows; `total` how many
 * there are in all. `paged`: the heading is one of the server's sections, whose remaining
 * releases `GET /artists/:id/releases` pages; otherwise the page already has them all.
 */
export type ReleaseGroup = { key: string; title: string; albums: readonly AlbumSummary[]; total: number; paged: boolean };

export const appearsOnKey = 'appears_on';

/** Headings in the app's words; a section a newer server adds keeps the server's title. */
const sectionTitles: Record<ArtistSectionKey, string> = {
  album: 'Albums', mixtape: 'Mixtapes', ep: 'EPs', single: 'Singles', live: 'Live Albums', compilation: 'Compilations',
  soundtrack: 'Soundtracks', other: 'Other Releases', appears_on: 'Appears On',
};

export function isArtistSectionKey(key: string): key is ArtistSectionKey {
  return (ARTIST_SECTION_KEYS as readonly string[]).includes(key);
}

/**
 * Discography headings of a server that sends every release in `albums`, grouped here. EPs
 * and singles share a rail, as on Apple Music; soundtracks and other releases keep their
 * own, apart from compilations.
 */
const legacyGroups: { key: string; title: string; types: readonly AlbumType[] }[] = [
  { key: 'album', title: 'Albums', types: ['album'] },
  { key: 'ep-single', title: 'EPs & Singles', types: ['ep', 'single'] },
  { key: 'compilation', title: 'Compilations', types: ['compilation'] },
  { key: 'live', title: 'Live Albums', types: ['live'] },
  { key: 'soundtrack', title: 'Soundtracks', types: ['soundtrack'] },
  { key: 'other', title: 'Other Releases', types: ['other'] },
];

/**
 * The artist's releases under their headings, empty headings left out: the server's
 * `sections` (the first few of each, with a count) or, from an older server, `albums`
 * grouped by type.
 */
export function releaseGroups(artist: Pick<ArtistDetail, 'albums' | 'appearsOn' | 'sections'>): ReleaseGroup[] {
  if (artist.sections) {
    return artist.sections.filter(section => section.items.length).map(section => ({
      key: section.key, title: isArtistSectionKey(section.key) ? sectionTitles[section.key] : section.title,
      albums: section.items, total: Math.max(section.total, section.items.length), paged: isArtistSectionKey(section.key),
    }));
  }
  // Filtered from the one list, so each heading keeps the server's newest-first order across its types.
  return [
    ...legacyGroups.map(group => ({ key: group.key, title: group.title, albums: artist.albums.filter(album => group.types.includes(album.type)) })),
    { key: appearsOnKey, title: 'Appears On', albums: artist.appearsOn ?? [] },
  ].filter(group => group.albums.length).map(group => ({ ...group, total: group.albums.length, paged: false }));
}
