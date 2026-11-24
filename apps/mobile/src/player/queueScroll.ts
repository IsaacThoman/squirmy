/**
 * The arithmetic of the iOS queue's scrolling, as Apple Music's queue scrolls: the heading of
 * the part in view sticks to the top until the next part pushes it off, and the page rests on
 * the song playing with the history above it, out of view.
 *
 * Positions are in the scroll view's content, measured from its top; `scrollY` is how far it
 * is scrolled. They run on the UI thread as the page scrolls, so each is a worklet.
 */

/** Where something was laid out in the scroll view's content. */
export type Band = { y: number; height: number };

/**
 * How far a sticky heading moves down from where it was laid out: enough to stay `pinAt`
 * below the top of the view, but never past `limit`, where its part of the page ends and the
 * next one pushes it off. Zero while it is in view where it was laid out.
 */
export function stickyShift(scrollY: number, band: Band, pinAt: number, limit = Infinity): number {
  'worklet';
  const pinned = scrollY + pinAt - band.y;
  const most = limit - band.height - band.y;
  return Math.max(0, Math.min(pinned, most));
}

/**
 * A pinned heading's opacity while the next one pushes it up under what is pinned above it
 * (`pinAt` from the top): it fades out over the first half of its height, so the two are never
 * read over each other.
 */
export function pushedOpacity(scrollY: number, band: Band, shift: number, pinAt: number): number {
  'worklet';
  const pushed = pinAt - (band.y + shift - scrollY);
  if (pushed <= 0 || band.height <= 0) return 1;
  return Math.max(0, 1 - pushed / (band.height / 2));
}

/**
 * How much of the top of `block` is cut away so that it ends at `line`, the bottom of the
 * heading pinned over it: rows go under a heading rather than show through it, since the
 * headings have no background of their own.
 */
export function clipInset(line: number, block: Band): number {
  'worklet';
  return Math.max(0, Math.min(block.height, line - block.y));
}

/**
 * Where the page rests: the song playing at the top (`home`, below the history), or scrolled
 * a full screen up into the history. Let go between the two, the page settles on one of them;
 * past them it scrolls freely. None without a history above the song.
 */
export function snapStops(home: number, viewport: number): number[] {
  if (home <= 0 || viewport <= 0) return [];
  return [Math.max(0, home - viewport), home];
}

/**
 * Where a page left at rest at `offset` settles, for when it jumps there rather than glides
 * (Reduce Motion): the nearer stop while it is between them, otherwise nowhere (null).
 */
export function restingStop(offset: number, stops: readonly number[]): number | null {
  if (stops.length < 2) return null;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (offset <= first || offset >= last) return null;
  return offset - first < last - offset ? first : last;
}
