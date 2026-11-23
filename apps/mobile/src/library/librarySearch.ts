import type { AlbumSummary, SearchResults } from '@squirmy/contracts';

/**
 * Library search answers from music with a file on the server, which includes songs fetched
 * only to be played. The Library lists what is in the viewer's library, so its search keeps
 * to that too: songs and artists say whether they are (`inLibrary`). Albums carry no such
 * flag, so they are kept here and narrowed by `libraryAlbumMatches`.
 */
export function inLibraryOnly(results: SearchResults): SearchResults {
  return {
    ...results,
    artists: results.artists.filter(artist => artist.inLibrary),
    // An older server does not say; then every song it found is kept.
    tracks: results.tracks.filter(track => track.inLibrary !== false),
  };
}

/**
 * The albums the Library's album list holds, and whether that is all of them (it was read to
 * its end). A plain list, since the query cache is saved as JSON.
 */
export type AlbumMembership = { ids: readonly string[]; complete: boolean };

/**
 * The album matches that are in the library, so the search finds what the Albums list
 * shows and no more. The server answers every album with a file, fetched-for-play ones
 * included, and an album summary does not say whether it is in the library, so the list
 * decides: an album it holds, or one the viewer saved (`liked`, which search results carry),
 * which covers a save made since the list was read. Until the list is in (`undefined`) no
 * album is shown, so none appears and then goes. A list not read to its end (`complete`
 * false: a very large library, or one that could not be read) cannot rule a match out, so
 * then every match is kept.
 */
export function libraryAlbumMatches(albums: readonly AlbumSummary[], membership: AlbumMembership | undefined): AlbumSummary[] {
  if (!membership) return [];
  if (!membership.complete) return [...albums];
  const listed = new Set(membership.ids);
  return albums.filter(album => album.liked === true || listed.has(album.id));
}
