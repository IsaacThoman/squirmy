import { searchItemKey, type SearchItem } from '@squirmy/client-core';
import type { AlbumSummary, ArtistSummary, PlaylistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { searchEnd, searchItems, searchNotice, searchStage } from './search';

const artist = (id: string, inLibrary = true): ArtistSummary => ({ id, mbid: null, name: id, image: null, inLibrary });
const album = (id: string, availability: AlbumSummary['availability'] = 'full'): AlbumSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], year: null, type: 'album', artwork: null, availability,
  trackCount: 10, ownedTrackCount: availability === 'full' ? 10 : 0,
});
const track = (id: string, availability: TrackSummary['availability'] = 'server'): TrackSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 1, album: null, disc: null, position: null,
  availability, liked: false, explicit: null, hasLyrics: false,
});
const playlist = (id: string, name: string): PlaylistSummary => ({
  id, name, description: null, ownerId: 'me', ownerName: 'me', isPublic: false, trackCount: 1, durationMs: 1, artworks: [], updatedAt: '2026-01-01T00:00:00.000Z',
});
const results = (parts: Partial<SearchResults>): SearchResults => ({ artists: [], albums: [], tracks: [], provider: null, ...parts });
const requester = { role: 'member', canAcquire: true } as const;
const listener = { role: 'member', canAcquire: false } as const;
const keys = (items: readonly SearchItem[]) => items.map(searchItemKey);

it('renders server playlist names and lyric-only tracks, with their excerpts', () => {
  const shared = playlist('public', 'Harbor Songs');
  const song = { ...track('lyric'), title: 'Low Tide' };
  const shown = searchItems(results({ playlists: [shared], lyrics: [{ track: song, snippet: 'A lantern in the harbor' }] }), undefined, null, 'harbor');
  expect(keys(shown)).toEqual(['playlist:public', 'track:lyric']);
  expect(shown[1]).toMatchObject({ lyricSnippet: 'A lantern in the harbor' });
});

describe('searchItems', () => {
  it('mixes every kind in the order the servers ranked them, without repeats', () => {
    const items = searchItems(
      results({ albums: [album('mine')], tracks: [track('played')], ranked: [{ type: 'album', id: 'mine', score: 0.6 }, { type: 'track', id: 'played', score: 0.5 }] }),
      results({
        artists: [artist('tate', false)], albums: [album('mine')], tracks: [track('played')],
        ranked: [{ type: 'artist', id: 'tate', score: 0.8 }, { type: 'track', id: 'played', score: 0.7 }],
      }),
      requester, 'tate',
    );
    expect(keys(items)).toEqual(['artist:tate', 'track:played', 'album:mine']);
  });

  it('lists the viewer’s playlists whose name matches, on the same scale', () => {
    const items = searchItems(
      results({ artists: [artist('x')], ranked: [{ type: 'artist', id: 'x', score: 0.5 }] }), undefined, requester, 'road',
      [playlist('p1', 'Road Trip'), playlist('p2', 'Gym')],
    );
    expect(keys(items)).toEqual(['playlist:p1', 'artist:x']);
  });

  it('scores down what the viewer cannot play', () => {
    const catalog = results({ tracks: [track('gray', 'on_demand'), track('plays')], ranked: [{ type: 'track', id: 'gray', score: 0.7 }, { type: 'track', id: 'plays', score: 0.6 }] });
    expect(keys(searchItems(undefined, catalog, requester, 'x'))).toEqual(['track:gray', 'track:plays']);
    expect(keys(searchItems(undefined, catalog, listener, 'x'))).toEqual(['track:plays', 'track:gray']);
  });
});

describe('searchStage', () => {
  it('waits for the catalog, or for a moment after the library', () => {
    expect(searchStage({ library: false, catalog: false, catalogFailed: false, waited: false })).toBe('wait');
    expect(searchStage({ library: true, catalog: false, catalogFailed: false, waited: false })).toBe('wait');
    expect(searchStage({ library: true, catalog: false, catalogFailed: false, waited: true })).toBe('partial');
    expect(searchStage({ library: true, catalog: false, catalogFailed: true, waited: false })).toBe('full');
    expect(searchStage({ library: false, catalog: true, catalogFailed: false, waited: false })).toBe('full');
  });
});

describe('searchNotice', () => {
  const list = { items: [] as unknown[], stale: false, pending: false, failed: false, catalogFailed: false };

  it('says a failed catalog search failed rather than that nothing was found', () => {
    expect(searchNotice({ ...list, catalogFailed: true }, false)).toBe('catalogEmpty');
    expect(searchNotice(list, false)).toBe('noResults');
  });

  it('notes a failed catalog beside rows from the server, but not over an earlier search', () => {
    expect(searchNotice({ ...list, items: [1], catalogFailed: true }, false)).toBe('catalogNote');
    expect(searchNotice({ ...list, items: [1], catalogFailed: true, stale: true, pending: true }, false)).toBeNull();
    expect(searchNotice({ ...list, items: [1] }, false)).toBeNull();
  });

  it('waits rather than say nothing was found while an answer is on its way', () => {
    expect(searchNotice({ ...list, pending: true }, false)).toBeNull();
    expect(searchNotice({ ...list, items: null, pending: true }, false)).toBe('searching');
  });

  it('puts being offline, then a failed search, first', () => {
    expect(searchNotice({ ...list, failed: true, items: null }, true)).toBe('offline');
    expect(searchNotice({ ...list, failed: true, items: null }, false)).toBe('failed');
  });

  it('shows what the phone found offline as it is, and says so only when it found nothing', () => {
    expect(searchNotice({ ...list, items: [1] }, true)).toBeNull();
    expect(searchNotice(list, true)).toBe('offline');
  });
});

describe('searchEnd', () => {
  const list = { items: [1] as unknown[], stale: false, pending: false, failed: false, catalogFailed: false };
  const retryMore = () => undefined;

  it('ends with the next page’s failure, which is asked for again only from Try again', () => {
    expect(searchEnd({ ...list, moreFailed: true, retryMore })).toBe('moreFailed');
    expect(searchEnd({ ...list, moreFailed: true, retryMore, pending: true })).toBe('loading');
    expect(searchEnd({ ...list, moreFailed: true, retryMore, stale: true })).toBeNull();
  });

  it('spins while more of a list with rows load', () => {
    expect(searchEnd({ ...list, pending: true })).toBe('loading');
    expect(searchEnd({ ...list, items: [], pending: true })).toBeNull();
    expect(searchEnd(list)).toBeNull();
  });
});
