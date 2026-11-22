import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { trackActions, type TrackActionState } from './trackActionList';

const track = (parts: Partial<TrackSummary> = {}): TrackSummary => ({
  id: 't', mbid: null, title: 'Song', artistCredit: 'Artist', artists: [{ id: 'ar', name: 'Artist' }], durationMs: 1,
  album: { id: 'al', title: 'Album', artwork: null }, disc: null, position: null,
  availability: 'server', liked: false, explicit: null, hasLyrics: false, ...parts,
} as TrackSummary);
const state = (parts: Partial<TrackActionState> = {}): TrackActionState => ({
  liked: false, playable: true, offline: false, isCurrent: false, download: undefined, onItsOwn: false, ...parts,
});
const ids = (...args: Parameters<typeof trackActions>) => trackActions(...args).map(action => action.id);

describe('trackActions', () => {
  it('offers everything for a playable track on the server', () => {
    expect(ids(track(), state())).toEqual(['play', 'next', 'last', 'like', 'download', 'playlist', 'radio', 'album', 'artist']);
  });

  it('resumes the current track instead of queueing it again', () => {
    expect(ids(track(), state({ isCurrent: true }))[0]).toBe('resume');
  });

  it('unlikes a liked track', () => {
    const like = trackActions(track(), state({ liked: true })).find(action => action.id === 'unlike');
    expect(like?.title).toBe('Remove from Liked Songs');
  });

  it('lets a gray track only be liked, wanted and opened', () => {
    expect(ids(track({ availability: 'none' }), state({ playable: false }))).toEqual(['like', 'want', 'album', 'artist']);
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
