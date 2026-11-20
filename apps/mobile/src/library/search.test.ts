import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { isEmptyGroup, searchSections } from './search';

const artist = (id: string, inLibrary = true): ArtistSummary => ({ id, mbid: null, name: id, image: null, inLibrary });
const album = (id: string, availability: AlbumSummary['availability'] = 'full'): AlbumSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], year: null, type: 'album', artwork: null, availability,
  trackCount: 10, ownedTrackCount: availability === 'full' ? 10 : 0,
});
const track = (id: string, availability: TrackSummary['availability'] = 'server'): TrackSummary => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 1, album: null, disc: null, position: null,
  availability, liked: false, explicit: null, hasLyrics: false,
});
const results = (parts: Partial<SearchResults>): SearchResults => ({ artists: [], albums: [], tracks: [], provider: null, ...parts });

describe('searchSections', () => {
  it('keeps the library and the catalog apart, without repeating what the library has', () => {
    const { groups } = searchSections(
      results({ artists: [artist('a')], albums: [album('b')], tracks: [track('t1')] }),
      results({ artists: [artist('a'), artist('c', false)], albums: [album('b'), album('d', 'none')], tracks: [track('t1'), track('t2', 'none')] }),
    );
    expect(groups.library).toEqual({ artists: [artist('a')], albums: [album('b')], tracks: [track('t1')] });
    expect(groups.catalog).toEqual({ artists: [artist('c', false)], albums: [album('d', 'none')], tracks: [track('t2', 'none')] });
  });

  it('leads with the library’s top hint', () => {
    const { top } = searchSections(
      results({ albums: [album('ok-computer')], tracks: [track('airbag')], top: { type: 'album', id: 'ok-computer' } }),
      results({ tracks: [track('creep', 'on_demand')], top: { type: 'track', id: 'creep' } }),
    );
    expect(top).toEqual({ group: 'library', type: 'album', album: album('ok-computer') });
  });

  it('falls back to the catalog’s hint, even when it names something in the library', () => {
    const owned = searchSections(results({ albums: [album('ok-computer')], top: null }),
      results({ albums: [album('ok-computer')], top: { type: 'album', id: 'ok-computer' } }));
    expect(owned.top).toEqual({ group: 'library', type: 'album', album: album('ok-computer') });
    const fetched = searchSections(results({}), results({ tracks: [track('creep', 'on_demand')], top: { type: 'track', id: 'creep' } }));
    expect(fetched.top).toEqual({ group: 'catalog', type: 'track', track: track('creep', 'on_demand') });
    expect(searchSections(results({}), results({ artists: [artist('x', false)], top: { type: 'artist', id: 'x' } })).top)
      .toEqual({ group: 'catalog', type: 'artist', artist: artist('x', false) });
  });

  it('has no top result without a hint, or with one naming nothing listed', () => {
    expect(searchSections(results({ tracks: [track('a')] }), undefined).top).toBeNull();
    expect(searchSections(results({ tracks: [track('a')], top: { type: 'album', id: 'a' } }), undefined).top).toBeNull();
    expect(searchSections(undefined, undefined)).toEqual({
      top: null, groups: { library: { artists: [], albums: [], tracks: [] }, catalog: { artists: [], albums: [], tracks: [] } },
    });
  });

  it('knows an empty group', () => {
    expect(isEmptyGroup({ artists: [], albums: [], tracks: [] })).toBe(true);
    expect(isEmptyGroup({ artists: [], albums: [], tracks: [track('a')] })).toBe(false);
  });
});
