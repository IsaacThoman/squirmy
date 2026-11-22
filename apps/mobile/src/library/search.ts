import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';

export type SearchGroup = { artists: ArtistSummary[]; albums: AlbumSummary[]; tracks: TrackSummary[] };

/** The result to lead with, and which group's list it is in. */
export type TopResult = { group: keyof SearchSections['groups'] } & (
  | { type: 'artist'; artist: ArtistSummary }
  | { type: 'album'; album: AlbumSummary }
  | { type: 'track'; track: TrackSummary }
);

export type SearchSections = { top: TopResult | null; groups: { library: SearchGroup; catalog: SearchGroup } };

/**
 * Your music, then the rest of the catalog without what is already in it, and the top
 * result: the library search's own `top` hint, else the catalog's. A hint naming nothing
 * in the lists (or a server without hints) gives no top result, and neither does one naming
 * an album or song nobody can play: leading with a gray tile above the user's own music
 * (catalog "Money Store" over the library's "The Money Store") reads as a wrong answer.
 */
export function searchSections(library: SearchResults | undefined, catalog: SearchResults | undefined): SearchSections {
  const known = new Set([...(library?.artists ?? []), ...(library?.albums ?? []), ...(library?.tracks ?? [])].map(item => item.id));
  const fresh = <T extends { id: string }>(items: readonly T[] | undefined) => (items ?? []).filter(item => !known.has(item.id));
  const groups = {
    library: { artists: [...(library?.artists ?? [])], albums: [...(library?.albums ?? [])], tracks: [...(library?.tracks ?? [])] },
    catalog: { artists: fresh(catalog?.artists), albums: fresh(catalog?.albums), tracks: fresh(catalog?.tracks) },
  };
  const find = (hint: SearchResults['top']): TopResult | null => {
    if (!hint) return null;
    for (const group of ['library', 'catalog'] as const) {
      const { artists, albums, tracks } = groups[group];
      if (hint.type === 'artist') {
        const artist = artists.find(item => item.id === hint.id);
        if (artist) return { group, type: 'artist', artist };
      } else if (hint.type === 'album') {
        const album = albums.find(item => item.id === hint.id);
        if (album) return album.availability === 'none' ? null : { group, type: 'album', album };
      } else {
        const track = tracks.find(item => item.id === hint.id);
        if (track) return track.availability === 'none' ? null : { group, type: 'track', track };
      }
    }
    return null;
  };
  return { top: find(library?.top) ?? find(catalog?.top), groups };
}

export function isEmptyGroup(group: SearchGroup): boolean {
  return !group.artists.length && !group.albums.length && !group.tracks.length;
}
