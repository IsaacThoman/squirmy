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

  it('offers to add a song to the wantlist, or to take it off once it is on it', () => {
    const gray = track({ availability: 'none' });
    expect(ids(gray, state({ playable: false }))).toContain('want');
    expect(ids(gray, state({ playable: false, wanted: true }))).toContain('unwant');
    expect(ids(gray, state({ playable: false, wanted: true }))).not.toContain('want');
  });

  it('leaves out Go to album on that album\'s own page', () => {
    expect(ids(track(), state(), { album: 'al' })).not.toContain('album');
    expect(ids(track(), state(), { album: 'other' })).toContain('album');
  });

  it('offers the current track only Play while paused, and never Play next', () => {
    expect(ids(track(), state({ current: 'paused' }))).toEqual(['resume', 'last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
    expect(trackActions(track(), state({ current: 'paused' }))[0]?.title).toBe('Play');
    expect(ids(track(), state({ current: 'playing' }))).toEqual(['last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
  });

  it('has one library entry that flips the heart', () => {
    const library = (liked: boolean) => trackActions(track(), state({ liked }))
      .filter(action => action.id === 'like' || action.id === 'unlike');
    expect(library(false)).toEqual([{ id: 'like', title: 'Save to library', icon: 'heart' }]);
    expect(library(true)).toEqual([{ id: 'unlike', title: 'Remove from library', icon: 'heart.slash' }]);
  });

  it('says on the library and wantlist entries that the server refused the last change, and tries it again', () => {
    const entry = (parts: Partial<TrackActionState>, gray = false) => trackActions(track(gray ? { availability: 'none' } : {}), state(parts))
      .filter(action => ['like', 'unlike', 'want', 'unwant'].includes(action.id));
    // A refused save was set back, so the entry saves again.
    expect(entry({ likeFailure: true })).toEqual([{ id: 'like', title: 'Couldn’t save to library. Try again', icon: 'exclamationmark.circle' }]);
    expect(entry({ liked: true, likeFailure: false })).toEqual([{ id: 'unlike', title: 'Couldn’t remove from library. Try again', icon: 'exclamationmark.circle' }]);
    expect(entry({ playable: false, wantFailure: true }, true)[1]).toEqual({ id: 'want', title: 'Couldn’t add to wantlist. Try again', icon: 'exclamationmark.circle' });
    expect(entry({ playable: false, wanted: true, wantFailure: false }, true)[1]).toEqual({ id: 'unwant', title: 'Couldn’t remove from wantlist. Try again', icon: 'exclamationmark.circle' });
  });

  it('lets a gray track only be saved, wanted and opened', () => {
    expect(ids(track({ availability: 'none' }), state({ playable: false }))).toEqual(['like', 'want', 'album', 'artist']);
  });

  it('starts a radio only from a song the server plays for this user', () => {
    const requester = { role: 'member', canAcquire: true } as const;
    const member = { role: 'member', canAcquire: false } as const;
    expect(ids(track({ availability: 'on_demand' }), state({ viewer: requester }))).toContain('radio');
    // Downloaded before the server let the file go: it plays here, but the server has no radio from it.
    expect(ids(track({ availability: 'on_demand' }), state({ viewer: member }))).not.toContain('radio');
    expect(ids(track({ availability: 'none' }), state({ viewer: requester }))).not.toContain('radio');
  });

  it('downloads a song the server does not have yet only for someone who may have it fetched', () => {
    const requester = { role: 'member', canAcquire: true } as const;
    const member = { role: 'member', canAcquire: false } as const;
    expect(ids(track({ availability: 'on_demand' }), state({ viewer: requester }))).toContain('download');
    expect(ids(track({ availability: 'on_demand' }), state({ viewer: member }))).not.toContain('download');
    expect(ids(track({ availability: 'none' }), state({ viewer: requester }))).not.toContain('download');
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

  it('offers the library entry for a collection song or one of a saved album too', () => {
    for (const library of ['collection', 'album', 'saved', null] as const) {
      expect(ids(track({ inLibrary: library !== null, library }), state())).toContain('like');
      expect(ids(track({ inLibrary: true, library }), state({ liked: true }))).toContain('unlike');
    }
  });

  it('keeps the library entry offline, where the heart waits for the server', () => {
    expect(ids(track(), state({ offline: true, liked: true }))).toContain('unlike');
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
