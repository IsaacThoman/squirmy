import { albumPresentation, isPlayable, mergeSearch, type MergedSearch, type SearchTop, type Viewer } from '@squirmy/client-core';
import type { SearchResults } from '@squirmy/contracts';

export type SearchView = MergedSearch & {
  /**
   * Sections held open while the catalog answer is on its way, because the library answer
   * had nothing for them. Drawn as placeholders of the same height, so what is already on
   * screen does not move down when the catalog's rows land under them.
   */
  waiting: { top: boolean; artists: boolean; albums: boolean };
  empty: boolean;
};

/**
 * One result set for a search, from the library and catalog answers (either may still be
 * loading): client-core's `mergeSearch`, so the rows the library answer showed keep their
 * places and the catalog's are appended. A top result the viewer can't play is left out:
 * leading with a gray tile reads as a wrong answer.
 */
export function searchView(
  library: SearchResults | undefined, catalog: SearchResults | undefined, viewer: Viewer | null | undefined, catalogPending: boolean,
): SearchView {
  const merged = mergeSearch(library, catalog, viewer);
  const top = merged.top && usable(merged.top, viewer) ? merged.top : null;
  const empty = !merged.artists.length && !merged.albums.length && !merged.tracks.length;
  const holding = catalogPending && !empty;
  return {
    ...merged,
    top,
    empty,
    waiting: { top: holding && !top, artists: holding && !merged.artists.length, albums: holding && !merged.albums.length },
  };
}

function usable(top: SearchTop, viewer: Viewer | null | undefined): boolean {
  if (top.type === 'album') return albumPresentation(top.album, viewer) === 'normal';
  if (top.type === 'track') return isPlayable(top.track, viewer);
  return true;
}

type Order = { artists: readonly string[]; albums: readonly string[]; tracks: readonly string[] };

/**
 * Keeps rows already on screen for this query where they were. A later answer for the same
 * query (a refresh after a play, which moves a played song up in the library's ranking)
 * may order them differently; moving rows under the finger reads as a glitch. Rows the
 * earlier answer did not have go after them, in their new order. Returns the view and the
 * order to pass next time.
 */
export function keepOrder(view: SearchView, previous: Order | null): { view: SearchView; order: Order } {
  const arrange = <T extends { id: string }>(items: readonly T[], before: readonly string[] | undefined): T[] => {
    if (!before?.length) return [...items];
    const place = new Map(before.map((id, index) => [id, index]));
    const known = items.filter(item => place.has(item.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!);
    return [...known, ...items.filter(item => !place.has(item.id))];
  };
  const artists = arrange(view.artists, previous?.artists);
  const albums = arrange(view.albums, previous?.albums);
  const tracks = arrange(view.tracks, previous?.tracks);
  const ids = (items: readonly { id: string }[]) => items.map(item => item.id);
  return { view: { ...view, artists, albums, tracks }, order: { artists: ids(artists), albums: ids(albums), tracks: ids(tracks) } };
}
