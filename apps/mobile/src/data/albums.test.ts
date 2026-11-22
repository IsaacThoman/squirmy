import { describe, expect, it } from 'vitest';
import { albumExpanding, albumPlaceholder, findAlbumSummary } from './albums';

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

describe('findAlbumSummary', () => {
  const album = { id: 'a1', title: 'Blonde', artistCredit: 'Frank Ocean', availability: 'none', trackCount: 17 };

  it('finds an album in search results, infinite pages and Home sections', () => {
    expect(findAlbumSummary([{ artists: [], albums: [album] }], 'a1')).toBe(album);
    expect(findAlbumSummary([{ pages: [{ items: [{ id: 'other' }, album] }], pageParams: [] }], 'a1')).toBe(album);
    expect(findAlbumSummary([{ sections: [{ kind: 'albums', albums: [album] }] }], 'a1')).toBe(album);
  });

  it('ignores a track with the same id, and finds nothing when absent', () => {
    expect(findAlbumSummary([{ tracks: [{ id: 'a1', title: 'Song' }] }], 'a1')).toBeUndefined();
    expect(findAlbumSummary([undefined, null, 3, 'x'], 'a1')).toBeUndefined();
  });
});

describe('albumPlaceholder', () => {
  it('keeps the summary and has no songs yet', () => {
    const placeholder = albumPlaceholder({
      id: 'a1', mbid: null, title: 'Blonde', artistCredit: 'Frank Ocean', artists: [], year: 2016, type: 'album', artwork: null,
      availability: 'none', trackCount: 17, ownedTrackCount: 0,
    });
    expect(placeholder.title).toBe('Blonde');
    expect(placeholder.discs).toEqual([]);
  });
});
