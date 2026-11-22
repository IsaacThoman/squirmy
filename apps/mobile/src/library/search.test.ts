import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { keepOrder, searchView } from './search';

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
const requester = { role: 'member', canAcquire: true } as const;
const listener = { role: 'member', canAcquire: false } as const;
const ids = (items: readonly { id: string }[]) => items.map(item => item.id);

describe('searchView', () => {
  it('lists the library rows first and appends the catalog rows, without repeats', () => {
    const view = searchView(
      results({ albums: [album('mine')], tracks: [track('played')] }),
      results({ albums: [album('found', 'on_demand'), album('mine')], tracks: [track('new', 'on_demand'), track('played')], artists: [artist('x', false)] }),
      requester, false,
    );
    expect(ids(view.albums)).toEqual(['mine', 'found']);
    expect(ids(view.tracks)).toEqual(['played', 'new']);
    expect(ids(view.artists)).toEqual(['x']);
  });

  it('keeps the rows shown before the catalog answered in their places', () => {
    const library = results({ tracks: [track('a'), track('b')] });
    const before = searchView(library, undefined, requester, true);
    const after = searchView(library, results({ tracks: [track('c', 'on_demand'), track('a')] }), requester, false);
    expect(ids(after.tracks).slice(0, ids(before.tracks).length)).toEqual(ids(before.tracks));
  });

  it('holds sections the library had nothing for while the catalog loads', () => {
    expect(searchView(results({ tracks: [track('a')] }), undefined, requester, true).waiting).toEqual({ top: true, artists: true, albums: true });
    expect(searchView(results({ albums: [album('a')], top: { type: 'album', id: 'a' } }), undefined, requester, true).waiting)
      .toEqual({ top: false, artists: true, albums: false });
    // Nothing yet at all: the screen shows its spinner instead of empty placeholders.
    expect(searchView(results({}), undefined, requester, true).waiting).toEqual({ top: false, artists: false, albums: false });
    expect(searchView(results({ tracks: [track('a')] }), results({}), requester, false).waiting).toEqual({ top: false, artists: false, albums: false });
  });

  it('takes the better-scored top result, the library one on a tie', () => {
    const library = results({ albums: [album('the-money-store')], top: { type: 'album', id: 'the-money-store', score: 2 } });
    const catalog = results({ albums: [album('money-store', 'on_demand')], top: { type: 'album', id: 'money-store', score: 3 } });
    expect(searchView(library, catalog, requester, false).top).toMatchObject({ type: 'album', album: { id: 'money-store' } });
    const tie = results({ ...catalog, top: { type: 'album', id: 'money-store', score: 2 } });
    expect(searchView(library, tie, requester, false).top).toMatchObject({ type: 'album', album: { id: 'the-money-store' } });
  });

  it('never leads with something the viewer cannot play', () => {
    const catalog = results({ tracks: [track('song', 'on_demand')], top: { type: 'track', id: 'song' } });
    expect(searchView(undefined, catalog, requester, false).top).toMatchObject({ type: 'track' });
    expect(searchView(undefined, catalog, listener, false).top).toBeNull();
    expect(searchView(undefined, results({ albums: [album('gone', 'none')], top: { type: 'album', id: 'gone' } }), requester, false).top).toBeNull();
  });

  it('puts what the viewer cannot play after what it can', () => {
    const view = searchView(undefined, results({ tracks: [track('gray', 'none'), track('plays', 'on_demand')] }), requester, false);
    expect(ids(view.tracks)).toEqual(['plays', 'gray']);
  });

  it('is empty only when neither answer has anything', () => {
    expect(searchView(undefined, undefined, requester, true).empty).toBe(true);
    expect(searchView(results({ artists: [artist('a')] }), undefined, requester, true).empty).toBe(false);
  });
});

describe('keepOrder', () => {
  it('keeps rows already shown in place when the same query is answered again', () => {
    const first = keepOrder(searchView(results({ tracks: [track('a'), track('b')] }), results({ tracks: [track('c', 'on_demand')] }), requester, false), null);
    expect(ids(first.view.tracks)).toEqual(['a', 'b', 'c']);
    // A refresh ranks c (just played) first and brings d.
    const again = keepOrder(searchView(results({ tracks: [track('c'), track('d'), track('a')] }), results({ tracks: [track('b', 'on_demand')] }), requester, false), first.order);
    expect(ids(again.view.tracks)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts over without an earlier order', () => {
    const view = searchView(results({ albums: [album('x'), album('y')] }), undefined, requester, true);
    expect(ids(keepOrder(view, null).view.albums)).toEqual(['x', 'y']);
  });
});
