import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventShownMs, PlaybackStatusStore, spokenStatus } from './playbackStatus';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const message = (store: PlaybackStatusStore) => store.current()?.message ?? null;

describe('PlaybackStatusStore', () => {
  it('shows a one-off event for a few seconds, and announces it', () => {
    const announce = vi.fn();
    const store = new PlaybackStatusStore(announce);
    store.report({ message: 'Skipped “Roygbiv” — not available' });
    expect(message(store)).toBe('Skipped “Roygbiv” — not available');
    expect(announce).toHaveBeenCalledWith('Skipped “Roygbiv” — not available');
    vi.advanceTimersByTime(eventShownMs - 1);
    expect(message(store)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.current()).toBeNull();
  });

  it('shows the newest event, for its own full time', () => {
    const store = new PlaybackStatusStore();
    store.report({ message: 'Skipped “A” — not available' });
    vi.advanceTimersByTime(eventShownMs - 1000);
    store.report({ message: 'Skipped 2 songs — not available' });
    vi.advanceTimersByTime(eventShownMs - 1);
    expect(message(store)).toBe('Skipped 2 songs — not available');
    vi.advanceTimersByTime(1);
    expect(store.current()).toBeNull();
  });

  it('keeps a lasting status until playback resumes, and announces both lines', () => {
    const announce = vi.fn();
    const store = new PlaybackStatusStore(announce);
    store.report({ message: 'Can’t load music right now', detail: 'Playback is paused.' }, { lasting: true });
    expect(announce).toHaveBeenCalledWith('Can’t load music right now. Playback is paused.');
    vi.advanceTimersByTime(eventShownMs * 10);
    expect(store.current()).toMatchObject({ message: 'Can’t load music right now', detail: 'Playback is paused.', lasting: true });
    store.resume();
    expect(store.current()).toBeNull();
  });

  it('shows an event over a lasting status, then the lasting one again', () => {
    const store = new PlaybackStatusStore();
    store.report({ message: 'Only downloaded or cached songs play offline.' }, { lasting: true });
    store.report({ message: 'This phone is playing with your other devices again.' });
    expect(message(store)).toBe('This phone is playing with your other devices again.');
    vi.advanceTimersByTime(eventShownMs);
    expect(message(store)).toBe('Only downloaded or cached songs play offline.');
  });

  it('lets a newer lasting status replace an event', () => {
    const store = new PlaybackStatusStore();
    store.report({ message: 'Couldn’t play “A”', detail: 'Skipped.' });
    store.report({ message: 'Several songs in a row aren’t available', detail: 'Playback is paused.' }, { lasting: true });
    expect(message(store)).toBe('Several songs in a row aren’t available');
    // The event's timer is gone with it, so nothing changes when it would have run out.
    vi.advanceTimersByTime(eventShownMs);
    expect(message(store)).toBe('Several songs in a row aren’t available');
  });

  it('keeps an event shown when playback resumes', () => {
    const store = new PlaybackStatusStore();
    store.report({ message: 'Can’t load music right now' }, { lasting: true });
    store.report({ message: 'Couldn’t play “A”', detail: 'Skipped.' });
    store.resume();
    expect(message(store)).toBe('Couldn’t play “A”');
    vi.advanceTimersByTime(eventShownMs);
    expect(store.current()).toBeNull();
  });

  it('tells subscribers of each change, and keeps the same object between them', () => {
    const store = new PlaybackStatusStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.report({ message: 'A' });
    const shown = store.current();
    expect(store.current()).toBe(shown);
    vi.advanceTimersByTime(eventShownMs);
    expect(listener).toHaveBeenCalledTimes(2);
    store.resume();
    expect(listener).toHaveBeenCalledTimes(2);
    store.report({ message: 'B' }, { lasting: true });
    store.clear();
    expect(store.current()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
    stop();
    store.report({ message: 'C' });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('speaks a status with its second line', () => {
    expect(spokenStatus({ message: 'Couldn’t play “A”', detail: 'Skipped.' })).toBe('Couldn’t play “A”. Skipped.');
    expect(spokenStatus({ message: 'Skipped 3 songs — not available' })).toBe('Skipped 3 songs — not available');
  });
});
