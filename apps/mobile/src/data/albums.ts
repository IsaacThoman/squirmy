import type { AlbumDetail, AlbumSummary } from '@squirmy/contracts';

/** How deep `findAlbumSummary` looks into a cached answer. */
const maxDepth = 5;

/**
 * How often an album page asks again for songs the server is still looking up, and for how
 * long it keeps asking (and saying it is looking) before it says the songs are late. As on web.
 */
export const trackListPollMs = 3000;
export const trackListWaitMs = 60_000;

/**
 * Whether the server is still looking up an album's songs: it lists none yet and says its
 * detail is pending (`detailPending`). An album the server has only heard of (from search or
 * a discography) comes back like that first; the answers that follow have the songs. The
 * same rule as web's `awaitsTrackList`.
 */
export function awaitsTrackList(album: Pick<AlbumDetail, 'discs' | 'detailPending'> | undefined): boolean {
  return album !== undefined && album.discs.every(disc => !disc.tracks.length) && Boolean(album.detailPending);
}

/**
 * How soon to ask again for an album whose page has waited `waitingFor` ms for its songs:
 * every `trackListPollMs` while it is `awaiting` them, for `trackListWaitMs`; then not at all,
 * and the page offers to check again, which starts a new wait.
 */
export function trackListPoll(waitingFor: number, awaiting: boolean): number | false {
  return awaiting && waitingFor < trackListWaitMs ? trackListPollMs : false;
}

function isAlbumSummary(value: object, id: string): value is AlbumSummary {
  return (value as { id?: unknown }).id === id && 'artistCredit' in value && 'availability' in value && 'trackCount' in value;
}

/**
 * The album as a list already on the phone showed it (a search result, a library page,
 * Home, an artist's discography), so its page can draw the header at once while the full
 * album loads; the first answer for an album the server has not filled in yet takes seconds.
 */
export function findAlbumSummary(cached: readonly unknown[], id: string): AlbumSummary | undefined {
  return findCached(cached, (value): value is AlbumSummary => isAlbumSummary(value, id));
}

/** The first object in cached answers that `matches`, looking `maxDepth` levels deep. */
export function findCached<T>(cached: readonly unknown[], matches: (value: object) => value is T & object): T | undefined {
  const visit = (value: unknown, depth: number): T | undefined => {
    if (depth > maxDepth || value === null || typeof value !== 'object') return undefined;
    const children = Array.isArray(value) ? value : matches(value) ? null : Object.values(value);
    if (!children) return value as T;
    for (const child of children) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const value of cached) {
    const found = visit(value, 0);
    if (found) return found;
  }
  return undefined;
}

/** An album page to show while the real one loads: the summary, with no songs yet. */
export function albumPlaceholder(album: AlbumSummary): AlbumDetail {
  return { ...album, releaseDate: null, genres: [], description: null, label: null, durationMs: 0, discs: [], liked: false, wanted: false };
}
