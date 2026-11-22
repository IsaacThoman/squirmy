import type { SessionClientSnapshot } from '@squirmy/client-core';
import { createInitialSession, splitSession } from '@squirmy/client-core';
import type { QueueEntry } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { loadingDelayMs, slowLoadingMs, waitsForAudio, watchLoading } from './loading';

const entry = (id: string, state: QueueEntry['state'] = 'ready'): QueueEntry => ({ id, trackId: `track-${id}`, albumId: null, durationMs: 1000, state });

function fakeSession() {
  const { state, queue } = splitSession(createInitialSession());
  let snapshot: SessionClientSnapshot = { session: state, queue, devices: [], connection: 'online', isActiveDevice: true, detached: false, canDetach: false };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (session: Partial<SessionClientSnapshot['session']>) => {
      snapshot = { ...snapshot, session: { ...snapshot.session, ...session } };
      for (const listener of [...listeners]) listener();
    },
  };
}

function fakeTimers() {
  let now = 0;
  let pending: { at: number; run: () => void; id: number }[] = [];
  let serial = 0;
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = ++serial;
      pending.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      pending = pending.filter(timer => timer.id !== id);
    },
    advance: (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = pending.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending = pending.filter(timer => timer !== due);
        now = due.at;
        due.run();
      }
      now = until;
    },
  };
}

describe('waitsForAudio', () => {
  it('is true while playing a preparing or stalled entry, and never while paused', () => {
    expect(waitsForAudio({ playing: true, stalled: false, current: entry('a', 'preparing') })).toBe(true);
    expect(waitsForAudio({ playing: true, stalled: true, current: entry('a') })).toBe(true);
    expect(waitsForAudio({ playing: true, stalled: false, current: entry('a') })).toBe(false);
    expect(waitsForAudio({ playing: false, stalled: true, current: entry('a', 'preparing') })).toBe(false);
    expect(waitsForAudio({ playing: true, stalled: true, current: null })).toBe(false);
  });
});

describe('watchLoading', () => {
  it('shows nothing for a short wait, then the spinner, then "Still loading" after 8 seconds', () => {
    const session = fakeSession();
    const timers = fakeTimers();
    const watch = watchLoading(session, timers);
    session.set({ playing: true, current: entry('a', 'preparing'), stalled: true });
    expect(watch.getSnapshot().phase).toBe('none');
    timers.advance(loadingDelayMs);
    expect(watch.getSnapshot()).toEqual({ trackId: 'track-a', phase: 'loading' });
    timers.advance(slowLoadingMs - loadingDelayMs - 1);
    expect(watch.getSnapshot().phase).toBe('loading');
    timers.advance(1);
    expect(watch.getSnapshot()).toEqual({ trackId: 'track-a', phase: 'slow' });
  });

  it('starts over for the next entry and clears once audio plays or playback pauses', () => {
    const session = fakeSession();
    const timers = fakeTimers();
    const watch = watchLoading(session, timers);
    session.set({ playing: true, current: entry('a', 'preparing'), stalled: true });
    timers.advance(slowLoadingMs);
    expect(watch.getSnapshot().phase).toBe('slow');
    session.set({ current: entry('b', 'preparing') });
    expect(watch.getSnapshot().phase).toBe('none');
    timers.advance(loadingDelayMs);
    expect(watch.getSnapshot()).toEqual({ trackId: 'track-b', phase: 'loading' });
    session.set({ current: entry('b'), stalled: false });
    expect(watch.getSnapshot().phase).toBe('none');
    session.set({ stalled: true });
    timers.advance(loadingDelayMs);
    expect(watch.getSnapshot().phase).toBe('loading');
    session.set({ playing: false });
    expect(watch.getSnapshot().phase).toBe('none');
  });

  it('tells its listeners only when the phase changes', () => {
    const session = fakeSession();
    const timers = fakeTimers();
    const watch = watchLoading(session, timers);
    let calls = 0;
    watch.subscribe(() => { calls += 1; });
    session.set({ playing: true, current: entry('a', 'preparing'), stalled: true });
    session.set({ positionMs: 0 });
    timers.advance(loadingDelayMs);
    session.set({ anchorAt: 5 });
    timers.advance(slowLoadingMs);
    expect(calls).toBe(2);
    watch.dispose();
    session.set({ playing: false });
    expect(calls).toBe(2);
  });
});
