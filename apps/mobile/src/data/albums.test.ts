import { describe, expect, it } from 'vitest';
import { albumPlaceholder, awaitsTrackList, findAlbumSummary, trackListPoll, trackListPollMs, trackListWaitMs } from './albums';

describe('awaitsTrackList', () => {
  it('waits for an album the server is still filling in', () => {
    expect(awaitsTrackList({ discs: [], detailPending: true })).toBe(true);
    expect(awaitsTrackList({ discs: [{ disc: 1, title: null, tracks: [] }], detailPending: true })).toBe(true);
  });

  it('does not wait once the songs are there, or for an album the server says is complete', () => {
    expect(awaitsTrackList({ discs: [{ disc: 1, title: null, tracks: [{} as never] }], detailPending: true })).toBe(false);
    expect(awaitsTrackList({ discs: [] })).toBe(false);
    expect(awaitsTrackList(undefined)).toBe(false);
  });
});

describe('trackListPoll', () => {
  it('asks again while the songs are awaited, for as long as the wait lasts', () => {
    expect(trackListPoll(0, true)).toBe(trackListPollMs);
    expect(trackListPoll(trackListWaitMs - 1, true)).toBe(trackListPollMs);
    expect(trackListPoll(trackListWaitMs, true)).toBe(false);
    expect(trackListPoll(0, false)).toBe(false);
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
