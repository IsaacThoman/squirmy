/**
 * The ids of the pages that show part of another one, as the phone builds them: a discography
 * heading's releases (`<artist>~<heading>`), and a list of songs (`top~<artist>`, `home~<section>`).
 */
export const releasesId = (artistId: string, group: string) => `${artistId}~${group}`;
export const songsId = (source: 'top' | 'home', id: string) => `${source}~${id}`;

/** The two halves of such an id; the second is empty for an id without `~`. */
export function splitId(id: string): readonly [string, string] {
  const at = id.indexOf('~');
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
}
