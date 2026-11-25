import { parseLrc } from '@squirmy/client-core';
import type { Lyrics } from '@squirmy/contracts';

export type LyricLine = { text: string; startMs: number | null };

/**
 * Lines to show for a track's lyrics: timed lines in order when synced LRC exists, the
 * plain text otherwise, read by the LRC parser the web app shares (it applies `[offset:…]`).
 */
export function lyricLines(lyrics: Pick<Lyrics, 'synced' | 'plain'> | null | undefined): { lines: LyricLine[]; synced: boolean } {
  if (lyrics?.synced) {
    // Empty timed lines mark instrumental gaps; they keep the timing but are not shown.
    const shown: LyricLine[] = parseLrc(lyrics.synced).filter(line => line.text);
    if (shown.length) return { lines: shown, synced: true };
  }
  const plain = (lyrics?.plain ?? '').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  return { lines: plain.map(text => ({ text, startMs: null })), synced: false };
}

/** The index of the line sung at `positionMs`, or -1 before the first. */
export function activeLine(lines: readonly LyricLine[], positionMs: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index]!.startMs;
    if (start === null || start > positionMs) break;
    active = index;
  }
  return active;
}

/**
 * Whether a line, by its center, is in the part of the lyrics a reader sees: scrolled to
 * `offset` with `viewport` points showing. A reader who scrolls back to the sung line has
 * returned to it, and the page follows the song again.
 */
export function lineInView(center: number | undefined, offset: number, viewport: number): boolean {
  return center !== undefined && viewport > 0 && center >= offset && center <= offset + viewport;
}

/**
 * Who wrote the song, from an LRC's `[au:…]` (author) or `[lr:…]` (lyricist) tag, for the
 * "Written By" line after the last lyric. Null when the lyrics name no one.
 */
export function lyricCredits(lyrics: Pick<Lyrics, 'synced'> | null | undefined): string | null {
  if (!lyrics?.synced) return null;
  const names = [/^\[au:([^\]]*)\]/im, /^\[lr:([^\]]*)\]/im]
    .map(tag => tag.exec(lyrics.synced!)?.[1]?.trim())
    .find(name => name);
  return names || null;
}

/** How a line is drawn: its opacity, and how blurred it is in points. */
export type LineLook = { opacity: number; blur: number };

/** Lines at least this far from the sung one are blurred to the full, however tall the page. */
export const blurReach = 8;
/** The shortest a lyric line is drawn: one line of large title and the space under it. */
const shortestLine = 48;
const blurStep = 1.1;
const blurMax = 5.5;
const dimmed = 0.3;
/** While a reader scrolls by hand, every line is readable, the sung one still a little brighter. */
const browsed = 0.62;

/**
 * How a line looks `distance` lines from the one being sung, as Apple Music draws lyrics:
 * the sung line bright and sharp, the others dim and blurred more the farther they are.
 * While a reader scrolls (`browsing`) nothing is blurred; without `blur` (Reduce Transparency,
 * Reduce Motion, VoiceOver) the lines are only dimmed. Plain lyrics, with no sung line, are all bright.
 */
export function lineLook(distance: number | null, { browsing, blur, reach = blurReach }: { browsing: boolean; blur: boolean; reach?: number }): LineLook {
  if (distance === null || distance === 0) return { opacity: 1, blur: 0 };
  if (browsing) return { opacity: browsed, blur: 0 };
  const away = Math.abs(distance);
  return { opacity: dimmed, blur: blur && away <= reach ? Math.min(blurMax, away * blurStep) : 0 };
}

/**
 * How far from the sung line the blur reaches on a page `viewport` points tall: every line that
 * can be on screen with it, so none past the end shows sharp on an iPad or with the transport hidden.
 * Lines beyond are only dimmed, which costs nothing to draw while they are off screen.
 */
export function blurReachFor(viewport: number): number {
  return Math.max(blurReach, Math.ceil(viewport / shortestLine) + 1);
}

/** Timing of the lyrics page, in milliseconds. */
export const lyricTiming = {
  /** With nothing touched for this long, the transport fades away and the lyrics take the screen. */
  hideControls: 4000,
  /** After a reader stops scrolling, this long until the page goes back to the sung line. */
  resumeFollow: 3000,
};

/**
 * What the lyrics page shows besides the lines: whether the transport is up, whether the page
 * follows the song, and when either changes on its own.
 */
export type LyricsChrome = {
  controls: boolean;
  following: boolean;
  hideAt: number | null;
  resumeAt: number | null;
};

/**
 * `canHide`: the transport may hide by itself. It may only for synced lyrics, while playing
 * and with VoiceOver off. `synced`: the page has a sung line to follow.
 */
export type ChromeRules = { canHide: boolean; synced: boolean };

export type ChromeEvent =
  /** The page came on screen. */
  | { type: 'show' }
  /** The rules changed: playback paused, VoiceOver turned on, lyrics loaded. */
  | { type: 'rules' }
  /** A tap on the lyrics, or on a line: the transport comes back and the page follows the song again. */
  | { type: 'tap' }
  /** A touch on the transport itself keeps it up. */
  | { type: 'touchControls' }
  /** A reader puts a finger on the lyrics to scroll them: the page stops following, and the transport stays as it is until they move. */
  | { type: 'grab' }
  /** A reader scrolls on through the lyrics: the transport gets out of the way. */
  | { type: 'scroll' }
  /** A reader scrolls back up the lyrics: the transport comes back, as in Apple Music. */
  | { type: 'scrollBack' }
  /** The scroll has come to rest. */
  | { type: 'rest' }
  /** Time has passed; see `chromeDeadline`. */
  | { type: 'tick' };

export const initialChrome: LyricsChrome = { controls: true, following: true, hideAt: null, resumeAt: null };

/**
 * The lyrics page's rules, as Apple Music's lyrics behave: the transport hides a few seconds
 * after the last touch and comes back on a tap. Scrolling on through the lyrics hides it too,
 * and scrolling back up brings it back. Either stops the page following the song until a few
 * seconds after the scroll rests, or a tap.
 */
export function lyricsChrome(state: LyricsChrome, event: ChromeEvent, now: number, rules: ChromeRules): LyricsChrome {
  const hideAt = rules.canHide ? now + lyricTiming.hideControls : null;
  switch (event.type) {
    case 'show':
      return { controls: true, following: true, hideAt, resumeAt: null };
    case 'rules':
      if (!rules.canHide) return { ...state, controls: true, hideAt: null };
      return state.controls && state.hideAt === null ? { ...state, hideAt } : state;
    case 'tap':
      return { controls: true, following: true, hideAt, resumeAt: null };
    case 'touchControls':
      return { ...state, controls: true, hideAt };
    case 'grab':
      // The transport stays while the finger is down; `rest` starts its timer again.
      return { ...state, following: !rules.synced, hideAt: rules.canHide ? null : state.hideAt, resumeAt: null };
    case 'scroll':
      return {
        controls: rules.canHide ? false : state.controls,
        following: !rules.synced,
        hideAt: rules.canHide ? null : state.hideAt,
        resumeAt: null,
      };
    case 'scrollBack':
      return { controls: true, following: !rules.synced, hideAt: null, resumeAt: null };
    case 'rest': {
      const hide = state.controls && rules.canHide && state.hideAt === null ? { hideAt } : {};
      return state.following ? { ...state, ...hide } : { ...state, ...hide, resumeAt: now + lyricTiming.resumeFollow };
    }
    case 'tick': {
      let next = state;
      if (next.hideAt !== null && now >= next.hideAt) next = { ...next, controls: false, hideAt: null };
      if (next.resumeAt !== null && now >= next.resumeAt) next = { ...next, following: true, resumeAt: null };
      return next;
    }
  }
}

/** How far a scroll must carry the lyrics one way before it counts as turning that way, in points. */
export const scrollTurn = 12;

/**
 * The run of a scroll so far, after a step of `step` points (positive is on through the
 * lyrics): steps the same way add up, and a step the other way starts a new run. A run of
 * `scrollTurn` or more decides which way the reader is going, so a finger's wobble does not.
 */
export function scrollRun(run: number, step: number): number {
  'worklet';
  return run === 0 || Math.sign(step) === Math.sign(run) ? run + step : step;
}

/** When the chrome next changes by itself, or null if it waits for a touch. */
export function chromeDeadline(state: LyricsChrome): number | null {
  const times = [state.hideAt, state.resumeAt].filter((time): time is number => time !== null);
  return times.length ? Math.min(...times) : null;
}

const springResponse = 0.5;
const springDamping = 0.82;
/** Long enough for the lines' spring to settle. */
export const waveDuration = 900;

/**
 * The share of their starting offset the lines still have to travel `elapsedMs` into their spring,
 * 1 before it starts and settling to 0 with a slight overshoot: a damped spring released
 * from rest, as SwiftUI's `spring(response: 0.5, dampingFraction: 0.82)`.
 */
export function springRemaining(elapsedMs: number): number {
  'worklet';
  if (elapsedMs <= 0) return 1;
  const t = elapsedMs / 1000;
  const omega = (2 * Math.PI) / springResponse;
  const decay = springDamping * omega;
  const ringing = omega * Math.sqrt(1 - springDamping * springDamping);
  return Math.exp(-decay * t) * (Math.cos(ringing * t) + (decay / ringing) * Math.sin(ringing * t));
}
