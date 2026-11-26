import type { ApiClient } from '@squirmy/client-core';
import type { SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackActions } from '../playback';
import { playMedia } from './siri';

const track: TrackSummary = {
  id: 'track-id', mbid: null, title: 'Night Drive', artistCredit: 'The Band', artists: [], durationMs: 180_000,
  album: null, disc: 1, position: 1, availability: 'server', liked: false, explicit: null, hasLyrics: false,
};

function setup() {
  const library = vi.fn(async (): Promise<SearchResults> => ({
    artists: [], albums: [], tracks: [track], provider: null, top: { type: 'track', id: track.id },
  }));
  const catalog = vi.fn(async () => undefined);
  const playHere = vi.fn(() => true);
  const resumeHere = vi.fn(() => true);
  return {
    context: {
      api: { search: { library, catalog } } as unknown as ApiClient,
      actions: { playHere, resumeHere } as unknown as PlaybackActions,
      offline: false, viewer: null, canPlay: () => true, isCurrent: () => true, signal: new AbortController().signal,
    },
    library, playHere, resumeHere,
  };
}

const request = { id: 'request', expiresAt: Number.MAX_SAFE_INTEGER };

describe('Siri media playback', () => {
  it('uses the existing search and starts a playable match on the phone', async () => {
    const { context, library, playHere } = setup();
    await expect(playMedia({ ...request, query: 'Night Drive', mediaType: 'track' }, context)).resolves.toBe(true);
    expect(library).toHaveBeenCalledWith({ q: 'Night Drive', type: 'track', limit: 12 }, { signal: context.signal });
    expect(playHere).toHaveBeenCalledWith([track], expect.objectContaining({
      start: 0, context: { type: 'search', id: null, title: 'Night Drive' },
    }));
  });

  it('resumes a saved session offline without searching', async () => {
    const { context, library, resumeHere } = setup();
    await expect(playMedia({ ...request, resume: true }, { ...context, offline: true })).resolves.toBe(true);
    expect(resumeHere).toHaveBeenCalledOnce();
    expect(library).not.toHaveBeenCalled();
  });

  it('drops a result resolved after the account or request changes', async () => {
    const { context, library, playHere } = setup();
    let current = true;
    library.mockImplementationOnce(async () => {
      current = false;
      return { artists: [], albums: [], tracks: [track], provider: null };
    });
    await expect(playMedia({ ...request, query: track.title }, { ...context, isCurrent: () => current })).resolves.toBe(false);
    expect(playHere).not.toHaveBeenCalled();
  });
});
