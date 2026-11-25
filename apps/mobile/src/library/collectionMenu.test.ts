import { describe, expect, it, vi } from 'vitest';
import { collectionActions, pinTarget } from './collectionMenu';
import type { Collection } from './shared';

const album: Collection = {
  key: 'a1', kind: 'album', title: 'Kid A', subtitle: 'Radiohead', href: '/album/a1', availability: 'full',
  artists: [{ name: 'Radiohead', href: '/artist/r1' }],
};
const online = { offline: false, viewer: null };
const runners = () => ({ playAlbum: vi.fn(), enqueueAlbum: vi.fn(), addAlbumToPlaylist: vi.fn(), open: vi.fn(), pin: vi.fn() });
const queueAndPlaylist = ['Play next', 'Add to queue', 'Add to playlist'];

describe('collectionActions', () => {
  it('gives an album its page’s menu but for saving, each entry running what it says', () => {
    const run = runners();
    const actions = collectionActions(album, online, run);
    expect(actions.map(action => action.title)).toEqual(['Play', 'Shuffle', ...queueAndPlaylist, 'Go to artist']);
    for (const action of actions) action.onPress();
    expect(run.playAlbum.mock.calls).toEqual([['a1', false], ['a1', true]]);
    expect(run.enqueueAlbum.mock.calls).toEqual([[album, 'next'], [album, 'last']]);
    expect(run.addAlbumToPlaylist).toHaveBeenCalledWith('a1');
    expect(run.open).toHaveBeenCalledWith('/artist/r1');
  });

  it('names each artist of an album with several', () => {
    const titles = collectionActions({ ...album, artists: [{ name: 'A', href: '/artist/a' }, { name: 'B', href: '/artist/b' }] }, online,
      runners()).map(action => action.title);
    expect(titles).toEqual(['Play', 'Shuffle', ...queueAndPlaylist, 'Go to A', 'Go to B']);
  });

  it('offers no playing or queueing for a gray album, and offline nothing that needs the server', () => {
    const run = runners();
    // As on web, a gray album's songs can still go in a playlist.
    expect(collectionActions({ ...album, dim: true }, online, run).map(action => action.title)).toEqual(['Add to playlist', 'Go to artist']);
    expect(collectionActions({ ...album, availability: 'on_demand' }, online, run).map(action => action.title)).toEqual(['Add to playlist', 'Go to artist']);
    expect(collectionActions({ ...album, availability: 'on_demand' }, { offline: false, viewer: { role: 'member', canAcquire: true } }, run)
      .map(action => action.title)).toEqual(['Play', 'Shuffle', ...queueAndPlaylist, 'Go to artist']);
    expect(collectionActions(album, { offline: true, viewer: null }, run).map(action => action.title)).toEqual(['Go to artist']);
  });

  it('opens anything else', () => {
    const run = runners();
    const actions = collectionActions({ key: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: '/playlist/liked' }, online, run);
    expect(actions.map(action => action.title)).toEqual(['Open']);
    actions[0]!.onPress();
    expect(run.open).toHaveBeenCalledWith('/playlist/liked');
  });

  it('ends with Pin or Unpin where it is known whether the item is pinned, and runs it', () => {
    const run = runners();
    const liked: Collection = { key: 'liked', kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', href: '/playlist/liked', pinned: false };
    const actions = collectionActions(liked, online, run);
    expect(actions.map(action => action.title)).toEqual(['Open', 'Pin to top']);
    actions[1]!.onPress();
    expect(run.pin).toHaveBeenCalledWith(liked, true);
    expect(collectionActions({ ...album, pinned: true }, online, run).map(action => action.title)).toEqual(['Play', 'Shuffle', ...queueAndPlaylist, 'Go to artist', 'Unpin']);
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
