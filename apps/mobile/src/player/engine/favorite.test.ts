import type { EngineEvent, EngineStatus, PlayerEngine } from '@squirmy/client-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { favoriteState, noFavorite } from './favorite';

type Listener = (command: { command: string; positionMs?: number }) => void;

const native = vi.hoisted(() => ({
  listener: undefined as ((command: { command: string; positionMs?: number }) => void) | undefined,
  setItem: vi.fn(() => Promise.resolve()),
  setPlayback: vi.fn(() => Promise.resolve()),
  setFavorite: vi.fn((_available: boolean, _active: boolean, _label: string) => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve()),
  addListener: vi.fn((_event: string, listener: (command: { command: string; positionMs?: number }) => void) => {
    native.listener = listener;
    return { remove: () => { native.listener = undefined; } };
  }),
}));
vi.mock('../../../modules/now-playing', () => ({ default: native }));

const { connectNowPlaying } = await import('./nowPlaying');

describe('favoriteState', () => {
  const track = { id: 't1', liked: false };

  it('is hidden until the track’s summary is in', () => {
    expect(favoriteState(undefined, new Map())).toEqual(noFavorite);
    expect(favoriteState(null, new Map())).toEqual(noFavorite);
  });

  it('follows the summary’s heart', () => {
    expect(favoriteState(track, new Map())).toEqual({ available: true, active: false, label: 'Save to library' });
    expect(favoriteState({ ...track, liked: true }, new Map())).toEqual({ available: true, active: true, label: 'Remove from library' });
  });

  it('takes a heart changed since the summary loaded, either way', () => {
    expect(favoriteState(track, new Map([['track:t1', true]])).active).toBe(true);
    expect(favoriteState({ ...track, liked: true }, new Map([['track:t1', false]])).active).toBe(false);
  });

  it('ignores hearts on other tracks, and on albums with the same id', () => {
    expect(favoriteState(track, new Map([['track:t2', true], ['album:t1', true]])).active).toBe(false);
  });
});

/** An engine that only reports a status; the lock screen never drives it. */
function fakeEngine(initial: EngineStatus) {
  let status = initial;
  const listeners = new Set<(event: EngineEvent) => void>();
  const engine = {
    getStatus: () => status,
    subscribe: (listener: (event: EngineEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PlayerEngine;
  const report = (next: EngineStatus) => {
    status = next;
    for (const listener of listeners) listener({ type: 'status', status } as EngineEvent);
  };
  return { engine, report };
}

describe('the lock screen’s star', () => {
  const item = { title: 'Tone', durationMs: 1000 };
  let liked: Record<string, boolean>;
  let onFavorite: ReturnType<typeof vi.fn<(entryId: string, saved: boolean) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    liked = { e1: false, e2: true };
    onFavorite = vi.fn<(entryId: string, saved: boolean) => void>();
  });

  const connect = (entryId: string | null) => {
    const { engine, report } = fakeEngine({ entryId, state: 'playing', positionMs: 0 } as EngineStatus);
    const nowPlaying = connectNowPlaying(engine, () => item, {
      onPlay: vi.fn(), onPause: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn(), onSeek: vi.fn(),
      favoriteFor: id => favoriteState(id in liked ? { id, liked: liked[id]! } : null, new Map()),
      onFavorite,
    });
    return { nowPlaying, report, tap: () => (native.listener as Listener)({ command: 'favorite' }) };
  };

  it('shows the current track’s heart with its item, and again only when it changes', () => {
    const { nowPlaying, report } = connect('e1');
    expect(native.setFavorite).toHaveBeenLastCalledWith(true, false, 'Save to library');
    nowPlaying.refreshFavorite();
    report({ entryId: 'e1', state: 'playing', positionMs: 500 } as EngineStatus);
    expect(native.setFavorite).toHaveBeenCalledTimes(1);

    liked.e1 = true;
    nowPlaying.refreshFavorite();
    expect(native.setFavorite).toHaveBeenLastCalledWith(true, true, 'Remove from library');
    expect(native.setFavorite).toHaveBeenCalledTimes(2);

    // The next track is saved too: the star already shows that.
    report({ entryId: 'e2', state: 'playing', positionMs: 0 } as EngineStatus);
    expect(native.setFavorite).toHaveBeenCalledTimes(2);
    liked.e1 = false;
    report({ entryId: 'e1', state: 'playing', positionMs: 0 } as EngineStatus);
    expect(native.setFavorite).toHaveBeenLastCalledWith(true, false, 'Save to library');
  });

  it('changes only the star, never the elapsed time, when the heart changes', () => {
    const { nowPlaying } = connect('e1');
    native.setItem.mockClear();
    native.setPlayback.mockClear();
    liked.e1 = true;
    nowPlaying.refreshFavorite();
    expect(native.setItem).not.toHaveBeenCalled();
    expect(native.setPlayback).not.toHaveBeenCalled();
  });

  it('asks for the other way from what the heart is now', () => {
    const { tap } = connect('e1');
    tap();
    expect(onFavorite).toHaveBeenLastCalledWith('e1', true);
    // Saved on another device since the star was drawn: the tap removes it.
    liked.e1 = true;
    tap();
    expect(onFavorite).toHaveBeenLastCalledWith('e1', false);
  });

  it('is hidden for a track without a summary, and a tap there does nothing', () => {
    liked = {};
    const { tap } = connect('e1');
    expect(native.setFavorite).not.toHaveBeenCalled();
    tap();
    expect(onFavorite).not.toHaveBeenCalled();
  });

  it('starts over after the lock screen is cleared', () => {
    const { report } = connect('e1');
    report({ entryId: null, state: 'idle', positionMs: 0 } as EngineStatus);
    expect(native.clear).toHaveBeenCalled();
    report({ entryId: 'e1', state: 'playing', positionMs: 0 } as EngineStatus);
    // Clearing hid the star, so the same state is sent again.
    expect(native.setFavorite).toHaveBeenCalledTimes(2);
  });

  it('ignores a tap while nothing is shown', () => {
    const { tap } = connect(null);
    tap();
    expect(onFavorite).not.toHaveBeenCalled();
  });
});
