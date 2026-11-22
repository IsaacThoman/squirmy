import type { SavedSession, SessionClient, TrackStore } from '@squirmy/client-core';
import type { SessionQueue, SessionState, TrackSummary } from '@squirmy/contracts';
import { accountItem } from '../data/accountStorage';
import { joinSaved, sameQueue, splitSaved, type SavedQueue, type SavedState } from './sessionHalves';

/** Summaries kept: the current entry, what comes next and a little history, not a whole long queue. */
const keptAhead = 200;
const keptBehind = 20;

const stateItem = (account: string) => accountItem<{ session: SavedState | SavedSession }>('session', account);
const queueItem = (account: string) => accountItem<SavedQueue>('sessionQueue', account);

/** The session as the last run left it, with the summaries its entries need to show offline. */
export function loadSession(account: string): { session: SavedSession; tracks: TrackSummary[] } | null {
  return joinSaved(stateItem(account).read(), queueItem(account).read());
}

/**
 * Returns a function that saves the session. The state half is small and written every
 * time; the queue half (thousands of entries on a long queue) only when it changed, or when
 * more of its summaries have loaded since. Both are written off the JS thread.
 */
export function sessionSaver(account: string, client: SessionClient, tracks: TrackStore): () => void {
  let savedQueue: SessionQueue | null = null;
  let savedTracks = -1;
  return () => {
    const { state, queue } = splitSaved(client.save());
    const snapshot = client.getSnapshot();
    const summaries = summariesOf(snapshot.session, snapshot.queue, tracks);
    if (!sameQueue(savedQueue, queue) || summaries.length !== savedTracks) {
      queueItem(account).writeAsync({ queue, tracks: summaries });
      savedQueue = queue;
      savedTracks = summaries.length;
    }
    stateItem(account).writeAsync({ session: state });
  };
}

/** Summaries of the session as this device shows it, its unsent commands applied. */
function summariesOf(state: SessionState, queue: SessionQueue, tracks: TrackStore): TrackSummary[] {
  const entries = [
    ...state.current ? [state.current] : [],
    ...queue.queue.slice(0, keptAhead),
    ...queue.autoplayQueue.slice(0, keptAhead),
    ...queue.history.slice(-keptBehind),
  ];
  return entries.flatMap(entry => tracks.peek(entry.trackId, entry.albumId) ?? []);
}
