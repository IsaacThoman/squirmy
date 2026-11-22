import { describe, expect, it } from 'vitest';
import { albumExpanding } from './albums';

describe('albumExpanding', () => {
  it('waits for an album that came back without tracks', () => {
    expect(albumExpanding({ trackCount: 0, discs: [] }, 1)).toBe(true);
  });

  it('stops waiting once the tracks are there, or after a few answers', () => {
    expect(albumExpanding({ trackCount: 12, discs: [{}] }, 2)).toBe(false);
    expect(albumExpanding({ trackCount: 0, discs: [] }, 6)).toBe(false);
    expect(albumExpanding(undefined, 0)).toBe(false);
  });
});
