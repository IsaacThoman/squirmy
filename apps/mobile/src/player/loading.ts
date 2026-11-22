import type { SessionClientSnapshot } from '@squirmy/client-core';
import type { SessionState } from '@squirmy/contracts';

/**
 * How long the current track waits before its subtitle says "Still loading…". A fetch takes
 * 4 to 9 seconds, so most never get there.
 */
export const slowLoadingMs = 8000;
/** A wait shorter than this (a track starting from a buffer) shows no spinner, so nothing flickers. */
export const loadingDelayMs = 300;

/**
 * - `none`: nothing is waited for, or not for long enough to show.
 * - `loading`: the buffering spinner shows in place of the pause button.
 * - `slow`: as `loading`, and the subtitle says "Still loading…".
 */
export type LoadingPhase = 'none' | 'loading' | 'slow';

export type Loading = { trackId: string | null; phase: LoadingPhase };

const none: Loading = { trackId: null, phase: 'none' };

/**
 * Whether the session should be playing but has no sound yet: the current entry is being
 * fetched (`preparing`) or the device playing it is buffering (`stalled`). A fetch is shown
 * exactly like buffering; where the bytes come from is not the listener's concern.
 */
export function waitsForAudio(session: Pick<SessionState, 'playing' | 'stalled' | 'current'>): boolean {
  return session.playing && session.current !== null && (session.current.state === 'preparing' || session.stalled);
}

type Source = { getSnapshot: () => SessionClientSnapshot; subscribe: (listener: () => void) => () => void };
type Timers = { now: () => number; setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void };

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Follows how long the current entry has waited for audio, as a store for
 * `useSyncExternalStore`. Its snapshot changes only when the phase does, so a component
 * that shows it re-renders twice per slow track at most.
 */
export function watchLoading(source: Source, timers: Timers = systemTimers) {
  let state = none;
  let waiting: { entryId: string; trackId: string; since: number } | null = null;
  let timer: unknown = null;
  const listeners = new Set<() => void>();

  const set = (wanted: Loading) => {
    const next = wanted.phase === 'none' ? none : wanted;
    if (next.trackId === state.trackId && next.phase === state.phase) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const update = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    const { session } = source.getSnapshot();
    const current = session.current;
    if (!current || !waitsForAudio(session)) {
      waiting = null;
      return set(none);
    }
    if (waiting?.entryId !== current.id) waiting = { entryId: current.id, trackId: current.trackId, since: timers.now() };
    const waited = timers.now() - waiting.since;
    const phase: LoadingPhase = waited >= slowLoadingMs ? 'slow' : waited >= loadingDelayMs ? 'loading' : 'none';
    if (phase !== 'slow') timer = timers.setTimeout(update, (phase === 'none' ? loadingDelayMs : slowLoadingMs) - waited);
    set({ trackId: current.trackId, phase });
  };
  const stop = source.subscribe(update);
  update();

  return {
    getSnapshot: (): Loading => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      stop();
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}

export type LoadingWatch = ReturnType<typeof watchLoading>;

/** The subtitle of a current track that has waited a while for audio, in place of its artist. */
export const STILL_LOADING_LABEL = 'Still loading…';

/** What the play/pause button says. While loading it shows a spinner and still pauses. */
export function playPauseLabel(playing: boolean, loading: LoadingPhase): string {
  if (loading !== 'none') return 'Loading. Pause';
  return playing ? 'Pause' : 'Play';
}
