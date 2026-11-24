import { describe, expect, it, vi } from 'vitest';
import { collectionActions, pinTarget } from './collectionMenu';
import type { Collection } from './shared';

const album: Collection = {
  key: 'a1', kind: 'album', title: 'Kid A', subtitle: 'Radiohead', href: '/album/a1', availability: 'full',
  artists: [{ name: 'Radiohead', href: '/artist/r1' }],
};
const online = { offline: false, viewer: null };

describe('collectionActions', () => {
  it('gives an album Play, Shuffle and Go to artist, which run what they say', () => {
    const run = { playAlbum: vi.fn(), open: vi.fn(), pin: vi.fn() };
    const actions = collectionActions(album, online, run);
    expect(actions.map(action => action.title)).toEqual(['Play', 'Shuffle', 'Go to artist']);
    actions[1]!.onPress();
    actions[2]!.onPress();
    expect(run.playAlbum).toHaveBeenCalledWith('a1', true);
    expect(run.open).toHaveBeenCalledWith('/artist/r1');
  });

  it('names each artist of an album with several', () => {
    const titles = collectionActions({ ...album, artists: [{ name: 'A', href: '/artist/a' }, { name: 'B', href: '/artist/b' }] }, online,
      { playAlbum: vi.fn(), open: vi.fn(), pin: vi.fn() }).map(action => action.title);
    expect(titles).toEqual(['Play', 'Shuffle', 'Go to A', 'Go to B']);
  });

  it('offers no playing for a gray album, or offline', () => {
    const run = { playAlbum: vi.fn(), open: vi.fn(), pin: vi.fn() };
    expect(collectionActions({ ...album, dim: true }, online, run).map(action => action.title)).toEqual(['Go to artist']);
    expect(collectionActions(album, { offline: true, viewer: null }, run).map(action => action.title)).toEqual(['Go to artist']);
  });

  it('opens anything else', () => {
    const run = { playAlbum: vi.fn(), open: vi.fn(), pin: vi.fn() };
    const actions = collectionActions({ key: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: '/playlist/liked' }, online, run);
    expect(actions.map(action => action.title)).toEqual(['Open']);
    actions[0]!.onPress();
    expect(run.open).toHaveBeenCalledWith('/playlist/liked');
  });

  it('ends with Pin or Unpin where it is known whether the item is pinned, and runs it', () => {
    const run = { playAlbum: vi.fn(), open: vi.fn(), pin: vi.fn() };
    const liked: Collection = { key: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: '/playlist/liked', pinned: false };
    const actions = collectionActions(liked, online, run);
    expect(actions.map(action => action.title)).toEqual(['Open', 'Pin to top']);
    actions[1]!.onPress();
    expect(run.pin).toHaveBeenCalledWith(liked, true);
    expect(collectionActions({ ...album, pinned: true }, online, run).map(action => action.title)).toEqual(['Play', 'Shuffle', 'Go to artist', 'Unpin']);
    // Not where it is unknown, nor offline.
    expect(collectionActions(album, online, run).map(action => action.title)).not.toContain('Pin to top');
    expect(collectionActions({ ...liked, pinned: true }, { offline: true, viewer: null }, run).map(action => action.title)).toEqual(['Open']);
  });

  it('pins Liked Songs by its own id, and anything else by its key', () => {
    expect(pinTarget({ key: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: '', href: '/' })).toEqual(['liked', '00000000-0000-0000-0000-000000000000']);
    expect(pinTarget(album)).toEqual(['album', 'a1']);
    expect(pinTarget({ key: 'recent', kind: 'recent', title: 'Recently Played', subtitle: '', href: '/' })).toBeNull();
  });
});
