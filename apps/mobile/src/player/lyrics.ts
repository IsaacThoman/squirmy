import type { Lyrics } from '@squirmy/contracts';

export type LyricLine = { text: string; startMs: number | null };

const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const offsetTag = /^\[offset:\s*([+-]?\d+)\]/im;

/**
 * Lines to show for a track's lyrics: timed lines in order when synced LRC exists, the
 * plain text otherwise. A line with several timestamps appears at each; tags such as
 * `[ar:…]` are dropped, and `[offset:…]` shifts every time as LRC defines (positive is earlier).
 */
export function lyricLines(lyrics: Pick<Lyrics, 'synced' | 'plain'> | null | undefined): { lines: LyricLine[]; synced: boolean } {
  if (lyrics?.synced) {
    const offset = Number(offsetTag.exec(lyrics.synced)?.[1] ?? 0);
    const lines: LyricLine[] = [];
    for (const raw of lyrics.synced.split(/\r?\n/)) {
      const times = [...raw.matchAll(stamp)];
      if (!times.length) continue;
      const text = raw.replace(stamp, '').trim();
      for (const [, minutes, seconds] of times) {
        lines.push({ text, startMs: Math.max(0, Math.round((Number(minutes) * 60 + Number(seconds!.replace(':', '.'))) * 1000) - offset) });
      }
    }
    lines.sort((a, b) => a.startMs! - b.startMs!);
    // Empty timed lines mark instrumental gaps; they keep the timing but are not shown.
    const shown = lines.filter(line => line.text);
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

/** Lines farther than this from the sung one are only dimmed; they are off screen while it is followed. */
export const blurReach = 8;
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
export function lineLook(distance: number | null, { browsing, blur }: { browsing: boolean; blur: boolean }): LineLook {
  if (distance === null || distance === 0) return { opacity: 1, blur: 0 };
  if (browsing) return { opacity: browsed, blur: 0 };
  const away = Math.abs(distance);
  return { opacity: dimmed, blur: blur && away <= blurReach ? Math.min(blurMax, away * blurStep) : 0 };
}

/** Timing of the lyrics page, in milliseconds. */
export const lyricTiming = {
  /** With nothing touched for this long, the transport fades away and the lyrics take the screen. */
  hideControls: 4000,
  /** After a reader stops scrolling, this long until the page goes back to the sung line. */
  resumeFollow: 3000,
  /** Each line starts moving this long after the one above it. */
  stagger: 42,
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
  /** A reader starts scrolling: the transport gets out of the way and the page stops following. */
  | { type: 'scroll' }
  /** The scroll has come to rest. */
  | { type: 'rest' }
  /** Time has passed; see `chromeDeadline`. */
  | { type: 'tick' };

export const initialChrome: LyricsChrome = { controls: true, following: true, hideAt: null, resumeAt: null };

/**
 * The lyrics page's rules, as Apple Music's lyrics behave: the transport hides a few seconds
 * after the last touch and comes back on a tap; scrolling hides it too and stops the page
 * following the song until a few seconds after the scroll rests, or a tap.
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
    case 'scroll':
      return {
        controls: rules.canHide ? false : state.controls,
        following: !rules.synced,
        hideAt: rules.canHide ? null : state.hideAt,
        resumeAt: null,
      };
    case 'rest':
      return state.following ? state : { ...state, resumeAt: now + lyricTiming.resumeFollow };
    case 'tick': {
      let next = state;
      if (next.hideAt !== null && now >= next.hideAt) next = { ...next, controls: false, hideAt: null };
      if (next.resumeAt !== null && now >= next.resumeAt) next = { ...next, following: true, resumeAt: null };
      return next;
    }
  }
}

/** When the chrome next changes by itself, or null if it waits for a touch. */
export function chromeDeadline(state: LyricsChrome): number | null {
  const times = [state.hideAt, state.resumeAt].filter((time): time is number => time !== null);
  return times.length ? Math.min(...times) : null;
}

const springResponse = 0.5;
const springDamping = 0.82;
/** Long enough for a line's spring to settle, after the last line's stagger. */
export const waveDuration = 900 + lyricTiming.stagger * 12;

/**
 * The share of its starting offset a line still has to travel `elapsedMs` into its spring,
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

/**
 * How long after a line change line `index` starts to move: the lines from just above the
 * sung one down, each a moment after the one above, so they ripple up rather than slide as one.
 */
export function lineDelay(index: number, from: number): number {
  'worklet';
  return Math.min(12, Math.max(0, index - from)) * lyricTiming.stagger;
}
