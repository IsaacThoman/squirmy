import type { Artwork } from '@squirmy/contracts';

/**
 * The covers of a playlist's mosaic, each picture once. Different albums can share one cover
 * (copies of an album, reissues), and a mosaic of the same picture four times says nothing.
 */
export function mosaicCovers(artworks: readonly Artwork[]): Artwork[] {
  const seen = new Set<string>();
  const covers: Artwork[] = [];
  for (const artwork of artworks) {
    if (seen.has(artwork.id)) continue;
    seen.add(artwork.id);
    covers.push(artwork);
  }
  return covers;
}
