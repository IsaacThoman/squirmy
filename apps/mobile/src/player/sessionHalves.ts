import type { SavedSession } from '@squirmy/client-core';
import type { SessionQueue, TrackSummary } from '@squirmy/contracts';

/** The small half, saved after every change: playback state and the commands not yet sent. */
export type SavedState = Omit<SavedSession, 'queue'>;
/** The large half (up to 5,000 entries per list), saved only when it changed, with the summaries its entries show. */
export type SavedQueue = { queue: SessionQueue; tracks: TrackSummary[] };

/** What a run before the session was saved in halves left: both in one item. */
type SavedWhole = { session: SavedSession; tracks: TrackSummary[] };

export function splitSaved(session: SavedSession): { state: SavedState; queue: SessionQueue } {
  const { queue, ...state } = session;
  return { state, queue };
}

/** The saved session, or null when there is none or its halves are missing. */
export function joinSaved(
  state: { session: SavedState | SavedSession } | null,
  queue: SavedQueue | null,
): { session: SavedSession; tracks: TrackSummary[] } | null {
  if (!state) return null;
  if ('queue' in state.session) return state as SavedWhole;
  if (!queue) return null;
  return { session: { ...state.session, queue: queue.queue }, tracks: queue.tracks };
}

/**
 * The session client keeps each list of the queue half by identity until it changes, so
 * comparing the lists themselves is enough, and cheap.
 */
export function sameQueue(a: SessionQueue | null, b: SessionQueue): boolean {
  return a !== null && a.queue === b.queue && a.history === b.history && a.autoplayQueue === b.autoplayQueue
    && a.playOrder === b.playOrder && a.playedInCycle === b.playedInCycle;
}
