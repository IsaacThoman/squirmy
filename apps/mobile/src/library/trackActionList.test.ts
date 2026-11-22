import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { trackActionKey, trackActions, type TrackActionState } from './trackActionList';

const track = (parts: Partial<TrackSummary> = {}): TrackSummary => ({
  id: 't', mbid: null, title: 'Song', artistCredit: 'Artist', artists: [{ id: 'ar', name: 'Artist' }], durationMs: 1,
  album: { id: 'al', title: 'Album', artwork: null }, disc: null, position: null,
  availability: 'server', liked: false, explicit: null, hasLyrics: false, ...parts,
} as TrackSummary);
const state = (parts: Partial<TrackActionState> = {}): TrackActionState => ({
  liked: false, playable: true, offline: false, current: null, download: undefined, onItsOwn: false, wantlist: true, ...parts,
});
const ids = (...args: Parameters<typeof trackActions>) => trackActions(...args).map(action => action.id);

describe('trackActions', () => {
  it('offers everything for a playable track on the server', () => {
    expect(ids(track(), state())).toEqual(['play', 'next', 'last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
  });

  it('offers the current track only Play while paused, and never Play next', () => {
    expect(ids(track(), state({ current: 'paused' }))).toEqual(['resume', 'last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
    expect(trackActions(track(), state({ current: 'paused' }))[0]?.title).toBe('Play');
    expect(ids(track(), state({ current: 'playing' }))).toEqual(['last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
  });

  it('unlikes a liked track', () => {
    const like = trackActions(track(), state({ liked: true })).find(action => action.id === 'unlike');
    expect(like?.title).toBe('Unlike');
  });

  it('lets a gray track only be liked, wanted and opened', () => {
    expect(ids(track({ availability: 'none' }), state({ playable: false }))).toEqual(['like', 'want', 'album', 'artist']);
  });

  it('adds to or removes from the library when the server says which it is', () => {
    expect(ids(track(), state({ saved: false }))).toEqual(['play', 'next', 'last', 'like', 'save', 'download', 'playlist', 'radio', 'album', 'artist']);
    expect(trackActions(track(), state({ saved: false })).find(action => action.id === 'save')?.title).toBe('Add to library');
    expect(ids(track(), state({ saved: true }))).toContain('unsave');
    expect(trackActions(track(), state({ saved: true })).find(action => action.id === 'unsave')?.title).toBe('Remove from library');
    // A gray track is not offered for adding, but one already added can still be removed.
    expect(ids(track({ availability: 'none' }), state({ playable: false, saved: false }))).not.toContain('save');
    expect(ids(track({ availability: 'none' }), state({ playable: false, saved: true }))).toContain('unsave');
    // Offline neither, and nothing for an older server that does not say.
    expect(ids(track(), state({ offline: true, saved: true }))).not.toContain('unsave');
    expect(ids(track(), state({ saved: undefined }))).not.toContain('save');
  });

  it('offers no wantlist when the server has it off', () => {
    expect(ids(track({ availability: 'none' }), state({ playable: false, wantlist: false }))).toEqual(['like', 'album', 'artist']);
  });

  it('leaves out what needs the server while offline', () => {
    expect(ids(track(), state({ offline: true }))).toEqual(['play', 'next', 'last', 'like', 'album', 'artist']);
  });

  it('removes or retries only a download made on its own', () => {
    const done = { state: 'done', bytes: 1, gone: false } as const;
    expect(ids(track(), state({ download: done, onItsOwn: true }))).toContain('removeDownload');
    expect(ids(track(), state({ download: done, onItsOwn: false }))).not.toContain('removeDownload');
    expect(ids(track(), state({ download: { state: 'failed', error: 'x' }, onItsOwn: true }))).toContain('retryDownload');
  });

  it('offers a page for each of the track\'s artists', () => {
    const featured = track({ artistCredit: 'Lead feat. Guest', artists: [{ id: 'lead', name: 'Lead' }, { id: 'guest', name: 'Guest' }] });
    const artists = trackActions(featured, state()).filter(action => action.id === 'artist');
    expect(artists.map(action => [action.title, action.page])).toEqual([
      ['Go to Lead', { page: 'artist', id: 'lead' }],
      ['Go to Guest', { page: 'artist', id: 'guest' }],
    ]);
    expect(new Set(artists.map(trackActionKey)).size).toBe(2);
    expect(trackActions(track(), state()).find(action => action.id === 'artist')?.title).toBe('Go to artist');
  });

  it('offers no library entry for a collection song or one of an album the user added', () => {
    for (const library of ['collection', 'album'] as const) {
      const actions = ids(track({ inLibrary: true, library }), state({ saved: true }));
      expect(actions).not.toContain('unsave');
      expect(actions).not.toContain('save');
    }
    expect(ids(track({ inLibrary: true, library: 'saved' }), state({ saved: true }))).toContain('unsave');
    expect(ids(track({ inLibrary: false, library: null }), state({ saved: false }))).toContain('save');
  });

  it('links to the album and artist pages without fixing the tab', () => {
    const actions = trackActions(track(), state());
    expect(actions.find(action => action.id === 'album')?.page).toEqual({ page: 'album', id: 'al' });
    expect(actions.find(action => action.id === 'artist')?.page).toEqual({ page: 'artist', id: 'ar' });
  });

  it('offers removal from the playlist the track is shown in, online only', () => {
    const playlist = { id: 'p', itemId: 'i' };
    expect(ids(track(), state(), { playlist }).at(-1)).toBe('remove');
    expect(ids(track(), state({ offline: true }), { playlist })).not.toContain('remove');
  });
});
