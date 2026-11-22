import type { AlbumDetail, AlbumSummary } from '@squirmy/contracts';

/** Tries to get the track list of an album the server is still filling in, about 2 s apart. */
const expandRetries = 5;
/** How deep `findAlbumSummary` looks into a cached answer. */
const maxDepth = 5;

/**
 * Whether an album's page should wait for its track list rather than show it empty. An
 * album the server has only heard of (from search or a discography) first comes back with
 * no tracks while the server looks them up; a later answer has them. `answers` counts the
 * answers so far, so a genuinely empty album stops being asked for.
 */
export function albumExpanding(album: { trackCount: number; discs: readonly unknown[] } | undefined, answers: number): boolean {
  return album !== undefined && album.trackCount === 0 && album.discs.length === 0 && answers <= expandRetries;
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
