import type { QueueEntry } from '@squirmy/contracts';

/** Where the player's artwork is drawn: its top left corner, its size and its corner radius, in points. */
export type ArtworkFrame = { x: number; y: number; size: number; radius: number };

/**
 * Draws the artwork at `frame` from a view laid out once, `base` points square at the window's
 * top left. Moving and scaling it costs no layout, and its image keeps the size it was decoded
 * at: a view that changes size makes the image redraw at each new size, soft while it grows.
 * The corner radius is divided by the scale so it is drawn at `frame.radius`.
 */
export function artworkTransform(frame: ArtworkFrame, base: number) {
  'worklet';
  const scale = frame.size / base;
  // Scaling is about the view's center; this shift puts its top left corner back at the frame's.
  const shift = (frame.size - base) / 2;
  return {
    transform: [{ translateX: frame.x + shift }, { translateY: frame.y + shift }, { scale }],
    borderRadius: frame.radius / scale,
  };
}

type Queue = { history: readonly QueueEntry[]; queue: readonly QueueEntry[]; autoplayQueue: readonly QueueEntry[] };

/**
 * The entries whose artwork Now Playing should have ready before they play: the next `ahead`
 * (Up next, then the Autoplay suggestions) and the one before, which Previous goes back to.
 */
export function upcomingArtworkEntries(queue: Queue, ahead = 2): QueueEntry[] {
  const next = [...queue.queue, ...queue.autoplayQueue].slice(0, ahead);
  const previous = queue.history.at(-1);
  return previous ? [...next, previous] : next;
}
