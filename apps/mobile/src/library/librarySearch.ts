import type { SearchResults } from '@squirmy/contracts';

/**
 * Library search answers from music with a file on the server, which includes songs fetched
 * only to be played. The Library lists what is in the viewer's library, so its search keeps
 * to that too: songs and artists say whether they are (`inLibrary`). Albums carry no such
 * flag yet, so they are kept.
 */
export function inLibraryOnly(results: SearchResults): SearchResults {
  return {
    ...results,
    artists: results.artists.filter(artist => artist.inLibrary),
    // An older server does not say; then every song it found is kept.
    tracks: results.tracks.filter(track => track.inLibrary !== false),
  };
}
