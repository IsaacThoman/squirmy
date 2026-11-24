/**
 * The arithmetic behind Now Playing's thumbless sliders, which a finger drags as Apple Music's:
 * by how far it moves, from wherever the value was, never jumping to where it touched down.
 */

/** How far past an end the track can be pulled, in points, however far the finger goes. */
export const stretchLimit = 14;

/** The resistance at the start of a pull: the first points past an end move the track this much each. */
const resistance = 0.55;

/**
 * How far the track stretches for a finger `overshoot` points past an end: as far as the finger
 * at first, then less and less, never beyond `limit`. UIScrollView's rubber band, signed.
 */
export function rubberBand(overshoot: number, limit = stretchLimit): number {
  if (!overshoot || limit <= 0) return 0;
  const distance = Math.abs(overshoot);
  return Math.sign(overshoot) * limit * (1 - 1 / (distance * resistance / limit + 1));
}

export type ScrubPoint = {
  /** Between 0 and `maximum`. */
  value: number;
  /** How far the track is pulled past an end, in points on screen: negative to the left, positive to the right. */
  stretch: number;
};

/**
 * Where a drag that started at `start` has taken the value: a drag across the track's whole
 * `width` covers the whole range. Right to left, a drag to the left raises it.
 */
export function scrubPoint(start: number, translation: number, width: number, maximum: number, rtl = false): ScrubPoint {
  if (width <= 0 || maximum <= 0) return { value: Math.min(Math.max(start, 0), Math.max(maximum, 0)), stretch: 0 };
  const direction = rtl ? -1 : 1;
  const raw = start + (translation * direction / width) * maximum;
  const value = Math.min(maximum, Math.max(0, raw));
  // The overshoot in points along the value's direction, turned back into screen direction.
  const overshoot = ((raw - value) / maximum) * width * direction;
  return { value, stretch: rubberBand(overshoot) };
}

/** Whether `next` has just arrived at an end that `previous` was not at. */
export function reachedEnd(previous: number, next: number, maximum: number): boolean {
  if (maximum <= 0) return false;
  return (next <= 0 && previous > 0) || (next >= maximum && previous < maximum);
}

export type Scrub = {
  /** The finger has moved `translation` points from where the drag began. */
  move(translation: number): ScrubPoint & { reachedEnd: boolean };
  /** The finger has lifted: the value to commit, or `null` for a drag that never moved or was cancelled. */
  release(canceled?: boolean): number | null;
};

/**
 * One drag across a slider. Only movement changes the value: a touch that lifts without moving,
 * such as a tap, commits nothing.
 */
export function startScrub(start: number, width: number, maximum: number, rtl = false): Scrub {
  let current = Math.min(Math.max(start, 0), Math.max(maximum, 0));
  let moved = false;
  return {
    move(translation) {
      const point = scrubPoint(start, translation, width, maximum, rtl);
      const ended = reachedEnd(current, point.value, maximum);
      if (translation !== 0) moved = true;
      current = point.value;
      return { ...point, reachedEnd: ended };
    },
    release(canceled = false) {
      return moved && !canceled ? current : null;
    },
  };
}

/**
 * After a seek, the scrubber keeps showing where it was let go until playback reports a
 * position this close to it, so it never flicks back to the old one while the seek lands.
 */
export const seekLandedWithinMs = 1500;

export function seekLanded(position: number, target: number): boolean {
  return Math.abs(position - target) <= seekLandedWithinMs;
}
