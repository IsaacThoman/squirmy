import { contextLabel } from '@squirmy/client-core';
import type { PlaybackContext, QueueEntry, SessionQueue, SessionState } from '@squirmy/contracts';
import { STILL_LOADING_LABEL } from '../../player/loading';

/**
 * The arithmetic behind the TV's Now Playing: which songs the carousel shows, how the remote
 * moves the playhead, and what the line under the titles says. Kept apart from the views so
 * it can be tested.
 */

/** A song in the carousel, `offset` places from the one playing (negative: already played). */
export type Slot = { entry: QueueEntry; offset: number };

/**
 * The songs around the one playing, as the system's music app lines them up: the last ones
 * played to the left, what plays next to the right. After the queue come the autoplay
 * suggestions while autoplay is on, since they play next. Empty when nothing plays.
 */
export function carouselSlots(
  session: Pick<SessionState, 'current' | 'autoplay'>,
  queue: Pick<SessionQueue, 'queue' | 'history' | 'autoplayQueue'>,
  reach = 2,
): Slot[] {
  if (!session.current) return [];
  const before = queue.history.slice(-reach).reverse().map((entry, index) => ({ entry, offset: -(index + 1) }));
  const ahead = (session.autoplay ? [...queue.queue, ...queue.autoplayQueue] : queue.queue).slice(0, reach)
    .map((entry, index) => ({ entry, offset: index + 1 }));
  return [...before.reverse(), { entry: session.current, offset: 0 }, ...ahead];
}

/**
 * Where the song now playing sat in the carousel before it changed, so the strip can slide
 * from there: 1 when playback moved on to the next song, -1 when it went back. 0 when the
 * song was not in view (a jump from the queue), which fades in rather than slides.
 */
export function slideFrom(previous: readonly Slot[], currentId: string | undefined): number {
  return previous.find(slot => slot.entry.id === currentId)?.offset ?? 0;
}

/** One press of the remote's left or right moves the playhead this far, as the system's players do. */
export const seekStepMs = 10_000;
/** Holding left or right moves it this far. */
export const longSeekStepMs = 30_000;
/** After the last press the playhead waits this long before playback seeks to it, so presses add up. */
export const seekSettleMs = 700;

const seekSteps: Readonly<Record<string, number>> = {
  left: -seekStepMs,
  right: seekStepMs,
  longLeft: -longSeekStepMs,
  longRight: longSeekStepMs,
};

/** How far a remote event moves the playhead, or null for one that does not. */
export function seekStep(eventType: string): number | null {
  return seekSteps[eventType] ?? null;
}

/** `from` moved by `step`, kept inside the song. A song of unknown length cannot be moved. */
export function steppedPosition(from: number, step: number, durationMs: number): number {
  if (!(durationMs > 0)) return from;
  return Math.min(Math.max(0, from + step), durationMs);
}

/** The share of the song played, 0 to 1. */
export function progressOf(positionMs: number, durationMs: number): number {
  return durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
}

/**
 * Where the elapsed time sits under the scrubber: centred under the playhead, as the system's
 * music app draws it, but never past either end of the bar. `labelWidth` is the time's width.
 */
export function elapsedLeft(progress: number, barWidth: number, labelWidth: number): number {
  const centre = progress * barWidth - labelWidth / 2;
  return Math.min(Math.max(0, centre), Math.max(0, barWidth - labelWidth));
}

/**
 * The quiet line at the top of the screen: where the music comes from (the album, playlist or
 * artist it was started from), or the song's album when it was started from nowhere in particular.
 */
export function containerTitle(context: PlaybackContext | null | undefined, albumTitle: string | undefined): string {
  return contextLabel(context)?.title ?? albumTitle ?? '';
}

export type StatusTone = 'notice' | 'quiet';
export type StatusLine = { text: string; detail?: string; tone: StatusTone } | null;

/**
 * What the line under the titles says, the most pressing first: what playback has to report
 * (a skipped song, a pause the server caused), a song that is slow to load, and where the music
 * plays when it is not this Apple TV. Nothing while all is well here.
 */
export function statusLine({ notice, slow, remote, where, detached }: {
  notice: { message: string; detail?: string } | null;
  slow: boolean;
  /** Another device plays; this Apple TV controls it. */
  remote: boolean;
  /** "Playing on Isaac’s iPhone", from `whereItPlays`. */
  where: string;
  detached: boolean;
}): StatusLine {
  if (notice) return { text: notice.message, ...notice.detail && { detail: notice.detail }, tone: 'notice' };
  if (slow) return { text: STILL_LOADING_LABEL, tone: 'quiet' };
  if (remote) return { text: where, tone: 'quiet' };
  if (detached) return { text: 'Only on this Apple TV', tone: 'quiet' };
  return null;
}

/** Without a press for this long while music plays, the controls fade away and leave the covers. */
export const idleAfterMs = 6000;

/**
 * What of Now Playing's controls is on screen: all of it, all but the scrubber (after Menu's
 * first press), or only the covers and titles (left alone while music plays).
 */
export type Chrome = 'shown' | 'menu' | 'idle';

/** The panel beside the cover: none (the carousel), the lyrics, or the queue. */
export type Panel = 'none' | 'lyrics' | 'queue';

/** The Lyrics and Up Next buttons open their panel, and close it when it is the one open. */
export function togglePanel(open: Panel, pressed: Exclude<Panel, 'none'>): Panel {
  return open === pressed ? 'none' : pressed;
}

/**
 * Whether the controls may fade by themselves: only while music plays, nothing is wrong, and the
 * queue is not open (a list being browsed is not idle).
 */
export function canIdle({ playing, panel, failed }: { playing: boolean; panel: Panel; failed: boolean }): boolean {
  return playing && !failed && panel !== 'queue';
}

/**
 * A colour from the cover lightened toward white by `white` (0 to 1), for type over the backdrop:
 * the system's music app tints its titles with the artwork's palette rather than plain white.
 * Null for a cover without a colour.
 */
export function inkFrom(color: string | null | undefined, white: number): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? '');
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * (1 - white) + 255 * white).toString(16).padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}
