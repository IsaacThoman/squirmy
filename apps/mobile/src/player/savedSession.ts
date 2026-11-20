import type { SavedSession, SessionClient, TrackStore } from '@squirmy/client-core';
import type { SessionQueue, SessionState, TrackSummary } from '@squirmy/contracts';
import { accountItem } from '../data/accountStorage';

/** The session as the last run left it, with the summaries its entries need to show offline. */
type Saved = { session: SavedSession; tracks: TrackSummary[] };

/** Summaries kept: the current entry, what comes next and a little history, not a whole long queue. */
const keptAhead = 200;
const keptBehind = 20;

export function loadSession(account: string): Saved | null {
  return accountItem<Saved>('session', account).read();
}

export function saveSession(account: string, client: SessionClient, tracks: TrackStore): void {
  const { session, queue } = client.getSnapshot();
  accountItem<Saved>('session', account).write({ session: client.save(), tracks: summariesOf(session, queue, tracks) });
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
