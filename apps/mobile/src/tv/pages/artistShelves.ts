import type { AlbumSummary, TrackSummary } from '@squirmy/contracts';
import { appearsOnKey, type ReleaseGroup } from '../../data/artists';
import { chunk } from '../../library/rows';

/** Tiles on a discography shelf before See all; the rest are a page away, as on the phone. */
export const shelfLimit = 20;
/** Top songs on the artist's page before See all. */
export const topSongLimit = 10;

/**
 * The artist's newest release of their own, which the page leads with as the system's music
 * app does: the newest of the first (newest) release of each of their sections, the earlier
 * section winning a tie, so an album beats a single from the same year. Null without one.
 */
export function latestRelease(groups: readonly ReleaseGroup[]): AlbumSummary | null {
  let latest: AlbumSummary | null = null;
  for (const group of groups) {
    if (group.key === appearsOnKey) continue;
    const first = group.albums[0];
    if (first?.year && (!latest?.year || first.year > latest.year)) latest = first;
    else if (first && !latest) latest = first;
  }
  return latest;
}

/** What the row beside the latest release holds: the top songs two to a column, then See all. */
export type TopRowItem =
  | { kind: 'latest'; key: string; album: AlbumSummary }
  | { kind: 'songs'; key: string; tracks: readonly TrackSummary[]; start: number; first: boolean }
  | { kind: 'all'; key: string };

export function topRow(latest: AlbumSummary | null, top: readonly TrackSummary[]): TopRowItem[] {
  const shown = top.slice(0, topSongLimit);
  return [
    ...(latest ? [{ kind: 'latest' as const, key: `latest:${latest.id}`, album: latest }] : []),
    ...chunk(shown, 2).map((tracks, column) => ({ kind: 'songs' as const, key: `songs:${column}`, tracks, start: column * 2, first: column === 0 })),
    ...(top.length > shown.length ? [{ kind: 'all' as const, key: 'all' }] : []),
  ];
}
