import type { Artwork } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { mosaicCovers } from './mosaic';

const artwork = (id: string) => ({ id, color: null, thumbhash: null }) as unknown as Artwork;

describe('mosaicCovers', () => {
  it('keeps each picture once, in order', () => {
    const covers = mosaicCovers([artwork('a'), artwork('b'), artwork('a'), artwork('c'), artwork('b')]);
    expect(covers.map(cover => cover.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves distinct covers alone', () => {
    expect(mosaicCovers([artwork('a'), artwork('b')]).map(cover => cover.id)).toEqual(['a', 'b']);
  });
});
