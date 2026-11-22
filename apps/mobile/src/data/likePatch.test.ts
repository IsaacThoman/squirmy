import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { findTrack, patchEntity, withLikedTrack } from './likePatch';

const track = (id: string, liked = false) => ({
  id, mbid: null, title: id, artistCredit: 'Artist', artists: [], durationMs: 1000, album: null, disc: null, position: null,
  availability: 'server', liked, explicit: null, hasLyrics: false,
}) as TrackSummary;
const list = (...pages: TrackSummary[][]) => ({ pages: pages.map(items => ({ items, nextCursor: null })), pageParams: pages.map(() => undefined) });

describe('patchEntity', () => {
  it('sets a field on every copy of the entity, wherever it is nested', () => {
    const album = { id: 'album', liked: false, discs: [{ disc: 1, tracks: [track('a'), track('b')] }] };
    const patched = patchEntity(album, 'a', { liked: true });
    expect(patched.discs[0]!.tracks.map(item => item.liked)).toEqual([true, false]);
    expect(patched.discs[0]!.tracks[1]).toBe(album.discs[0]!.tracks[1]);
  });

  it('returns the same data when nothing matched, and only sets fields the entity has', () => {
    const data = { list: [track('a')], other: { id: 'x' } };
    expect(patchEntity(data, 'nobody', { liked: true })).toBe(data);
    expect(patchEntity(data, 'x', { liked: true })).toBe(data);
  });
});

describe('findTrack', () => {
  it('finds a track summary by id, not another entity with the same id field', () => {
    const data = { sections: [{ id: 's', albums: [{ id: 'a', title: 'Album' }] }, { id: 't', tracks: [track('a')] }] };
    expect(findTrack(data, 'a')).toBe(data.sections[1]!.tracks![0]);
    expect(findTrack(data, 'missing')).toBeUndefined();
  });
});

describe('withLikedTrack', () => {
  it('puts a newly liked track at the top', () => {
    const data = list([track('b', true)], [track('c', true)]);
    const next = withLikedTrack(data, 'a', track('a'));
    expect(next.pages.map(page => page.items.map(item => [item.id, item.liked]))).toEqual([[['a', true], ['b', true]], [['c', true]]]);
    expect(next.pages[1]).toBe(data.pages[1]);
    expect(withLikedTrack(next, 'a', track('a'))).toBe(next);
  });

  it('removes an unliked track from the page that holds it', () => {
    const data = list([track('a', true)], [track('b', true)]);
    const next = withLikedTrack(data, 'b', null);
    expect(next.pages.map(page => page.items.map(item => item.id))).toEqual([['a'], []]);
    expect(next.pages[0]).toBe(data.pages[0]);
    expect(withLikedTrack(data, 'z', null)).toBe(data);
  });
});
