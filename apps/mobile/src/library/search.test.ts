import { searchItemKey, type SearchItem } from '@squirmy/client-core';
import type { AlbumSummary, ArtistSummary, PlaylistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { searchItems, searchStage } from './search';

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
