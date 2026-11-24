import type { QueueEntry, SessionQueue, SessionState } from '@squirmy/contracts';

/**
 * A sideways swipe changes the song: on Now Playing's artwork, and on the mini-player, where
 * the title slides with the finger and the neighbouring song's slides in after it. The two
 * share these numbers so they feel alike.
 */

/** How far a slow swipe must travel to change the song. */
export const skipDistance = 60;
/** A flick this fast changes the song from `flickDistance` on. */
const flickVelocity = 720;
const flickDistance = 20;
/** Flung back the other way at least this fast, a swipe past `skipDistance` is called off. */
const reverseVelocity = 300;
/** How far the title gives when there is no song that way, at most. */
export const rubberBandLimit = 36;

/** Whether a swipe that ended at `translationX`, moving at `velocityX`, changes the song. */
export function skipCommits(translationX: number, velocityX: number): boolean {
  'worklet';
  const distance = Math.abs(translationX);
  if (distance === 0) return false;
  const along = velocityX * Math.sign(translationX);
  if (along < -reverseVelocity) return false;
  return distance > skipDistance || (distance > flickDistance && along > flickVelocity);
}

/** The song a swipe goes to: to the left plays the next one (+1), to the right the one before (-1). */
export function skipDirection(translationX: number): 1 | -1 {
  'worklet';
  return translationX < 0 ? 1 : -1;
}

/**
 * The finger's travel `offset` turned into a pull that gives less the further it goes, and
 * never past `limit`, like a scroll view pulled past its end.
 */
export function rubberBand(offset: number, limit?: number): number {
  'worklet';
  // Not a default parameter: a worklet does not capture what one refers to.
  const most = limit ?? rubberBandLimit;
  if (most <= 0) return 0;
  const pulled = (1 - 1 / ((Math.abs(offset) * 0.55) / most + 1)) * most;
  return Math.sign(offset) * pulled;
}

/**
 * Where the mini-player's titles sit for a finger `translationX` along: they follow it, up to
 * a whole page (`width`), towards a song there is; towards none they only give a little.
 */
export function swipeOffset(translationX: number, width: number, canNext: boolean, canPrevious: boolean): number {
  'worklet';
  const open = translationX < 0 ? canNext : canPrevious;
  if (!open) return rubberBand(translationX);
  return Math.max(-width, Math.min(width, translationX));
}

type Entries = Pick<SessionState, 'current' | 'repeat' | 'autoplay'>
  & Pick<SessionQueue, 'queue' | 'autoplayQueue' | 'playedInCycle'>;

const playable = (entry: QueueEntry) => entry.state !== 'failed';

/**
 * The entry `next` would start, as the session reducer picks it: the queue (already in
 * shuffled order with shuffle on), then a new repeat-all cycle, then the autoplay queue.
 * Repeat one does not hold a skip on the same song. Null when `next` would only pause.
 */
export function nextEntry(session: Entries): QueueEntry | null {
  if (!session.current) return null;
  const queued = session.queue.find(playable);
  if (queued) return queued;
  if (session.repeat === 'all') {
    const again = [...session.playedInCycle, session.current].find(entry => playable(entry) && !entry.queued);
    if (again) return again;
  }
  if (session.autoplay) return session.autoplayQueue.find(playable) ?? null;
  return null;
}

/**
 * The entry `previous` with `restart: false` goes back to: the last playable one behind the
 * current entry in this cycle. Null when there is none.
 */
export function previousEntry(session: Entries): QueueEntry | null {
  if (!session.current) return null;
  return session.playedInCycle.findLast(playable) ?? null;
}

/** A skip the mini-player has animated and dispatched, waiting for the session to show it. */
export type PendingSkip = { from: string; direction: 1 | -1 };

/**
 * Which page the titles' strip shows the current entry on. The strip moves on the UI thread
 * and never jumps back; instead each song it lands on gets the next page along, decided in
 * the same render that shows the song, so the slide and the new title cannot disagree for
 * a frame. A song that changes any other way (a button, the lock screen, the song ending)
 * takes the place of the one shown, on the same page.
 */
export function landedPage(shown: { id: string | null; page: number }, currentId: string | null, pending: PendingSkip | null): number {
  if (shown.id === currentId) return shown.page;
  return shown.page + (pending && pending.from === shown.id ? pending.direction : 0);
}
