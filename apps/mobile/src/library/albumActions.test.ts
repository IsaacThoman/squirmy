import { describe, expect, it, vi } from 'vitest';
import { albumActions, queuedMessage, repeatedAddPrompt, type AlbumMenuState } from './albumActions';

const state = (parts: Partial<AlbumMenuState> = {}): AlbumMenuState => ({ plays: true, offline: false, artists: [{ name: 'Low Hum' }], ...parts });
const runners = () => ({
  play: vi.fn(), enqueue: vi.fn(), addToPlaylist: vi.fn(), setSaved: vi.fn(), setWanted: vi.fn(), goToArtist: vi.fn(), share: vi.fn(),
});
const titles = (parts?: Partial<AlbumMenuState>) => albumActions(state(parts), runners()).map(action => action.title);

describe('albumActions', () => {
  it('lists the page’s menu in web’s order, and each entry runs what it says', () => {
    const run = runners();
    const actions = albumActions(state({ saved: { liked: false }, share: true }), run);
    expect(actions.map(action => action.title)).toEqual([
      'Play', 'Shuffle', 'Play next', 'Add to queue', 'Add to playlist', 'Save to library', 'Go to artist', 'Share',
    ]);
    for (const action of actions) action.onPress();
    expect(run.play.mock.calls).toEqual([[false], [true]]);
    expect(run.enqueue.mock.calls).toEqual([['next'], ['last']]);
    expect(run.addToPlaylist).toHaveBeenCalledOnce();
    expect(run.setSaved).toHaveBeenCalledWith(true);
    expect(run.goToArtist).toHaveBeenCalledWith(0);
    expect(run.share).toHaveBeenCalledOnce();
  });

  it('removes a saved album, and says a refused change failed so choosing it tries again', () => {
    const run = runners();
    const [saved] = albumActions(state({ plays: false, offline: true, artists: [], saved: { liked: true } }), run);
    expect(saved).toMatchObject({ title: 'Remove from library', icon: 'heart.slash' });
    saved!.onPress();
    expect(run.setSaved).toHaveBeenCalledWith(false);
    expect(titles({ saved: { liked: true, failed: true } })).toContain('Couldn’t remove from library. Try again');
    expect(titles({ saved: { liked: false, failed: true } })).toContain('Couldn’t save to library. Try again');
  });

  it('offers playing and queueing only for what plays, and a playlist only once the songs are known and online', () => {
    expect(titles({ plays: false })).toEqual(['Add to playlist', 'Go to artist']);
    expect(titles({ songsKnown: false })).toEqual(['Play', 'Shuffle', 'Play next', 'Add to queue', 'Go to artist']);
    // Offline, a downloaded album still plays and queues; a playlist needs the server.
    expect(titles({ offline: true })).toEqual(['Play', 'Shuffle', 'Play next', 'Add to queue', 'Go to artist']);
  });

  it('offers the wantlist where it is asked for, online only', () => {
    const run = runners();
    const actions = albumActions(state({ plays: false, want: { wanted: false } }), run);
    expect(actions.map(action => action.title)).toEqual(['Add to playlist', 'Add to wantlist', 'Go to artist']);
    actions[1]!.onPress();
    expect(run.setWanted).toHaveBeenCalledWith(true);
    expect(titles({ plays: false, want: { wanted: true } })).toContain('Remove from wantlist');
    expect(titles({ plays: false, want: { wanted: true, failed: true } })).toContain('Couldn’t remove from wantlist. Try again');
    expect(titles({ plays: false, offline: true, want: { wanted: false } })).toEqual(['Go to artist']);
  });

  it('names each artist of an album with several', () => {
    const run = runners();
    const actions = albumActions(state({ plays: false, offline: true, artists: [{ name: 'A' }, { name: 'B' }] }), run);
    expect(actions.map(action => action.title)).toEqual(['Go to A', 'Go to B']);
    actions[1]!.onPress();
    expect(run.goToArtist).toHaveBeenCalledWith(1);
  });

  it('leaves out what has no runner', () => {
    expect(albumActions(state({ saved: { liked: false }, share: true }), { play: vi.fn(), enqueue: vi.fn(), addToPlaylist: vi.fn(), goToArtist: vi.fn() })
      .map(action => action.title)).not.toContain('Save to library');
  });
});

describe('queuedMessage', () => {
  it('says where the songs went', () => {
    expect(queuedMessage('next')).toBe('Playing next');
    expect(queuedMessage('last')).toBe('Added to queue');
  });
});

describe('repeatedAddPrompt', () => {
  const songs = [{ id: 't1', title: 'Paper Lanterns' }, { id: 't2', title: 'Slow Tide' }, { id: 't3', title: 'Glass Hours' }];

  it('asks nothing when none is in the playlist yet', () => {
    expect(repeatedAddPrompt('Mix', songs, [])).toBeNull();
  });

  it('asks about one song by name, as before', () => {
    expect(repeatedAddPrompt('Mix', songs.slice(0, 1), songs.slice(0, 1))).toEqual({ title: 'Already in “Mix”', message: 'Add “Paper Lanterns” again?', skip: null });
  });

  it('asks about all of them with no Skip, which would add nothing', () => {
    expect(repeatedAddPrompt('Mix', songs, songs)).toEqual({ title: 'Already in “Mix”', message: 'All 3 songs are already in this playlist. Add them again?', skip: null });
  });

  it('offers to skip the songs there already when only some are', () => {
    expect(repeatedAddPrompt('Mix', songs, songs.slice(0, 1))).toEqual({
      title: 'Already in “Mix”', message: '1 of these 3 songs is already in this playlist. Skip adds only the other 2 songs.', skip: 'Skip',
    });
  });
});
