import type { QueueEntry } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { artworkTransform, upcomingArtworkEntries } from './artwork';

/** Where the transform puts a `base`-square view laid out at the origin, as Core Animation draws it about its center. */
function drawn(style: ReturnType<typeof artworkTransform>, base: number) {
  const [{ translateX }, { translateY }, { scale }] = style.transform as [{ translateX: number }, { translateY: number }, { scale: number }];
  const size = base * scale;
  return { x: translateX + (base - size) / 2, y: translateY + (base - size) / 2, size, radius: style.borderRadius * scale };
}

describe('artworkTransform', () => {
  it('draws the artwork at its frame from a view laid out once at full size', () => {
    for (const frame of [
      { x: 24, y: 160, size: 354, radius: 21 },
      { x: 28, y: 18, size: 42, radius: 8 },
      { x: 24, y: 130, size: 54, radius: 11 },
      { x: 61.5, y: 77.25, size: 190.5, radius: 14.5 },
    ]) {
      const result = drawn(artworkTransform(frame, 354), 354);
      expect(result.x).toBeCloseTo(frame.x, 9);
      expect(result.y).toBeCloseTo(frame.y, 9);
      expect(result.size).toBeCloseTo(frame.size, 9);
      expect(result.radius).toBeCloseTo(frame.radius, 9);
    }
  });

  it('leaves the view unscaled at its own size', () => {
    expect(artworkTransform({ x: 10, y: 20, size: 300, radius: 21 }, 300)).toEqual({
      transform: [{ translateX: 10 }, { translateY: 20 }, { scale: 1 }],
      borderRadius: 21,
    });
  });
});

const entry = (id: string): QueueEntry => ({ id, trackId: `track-${id}`, albumId: null, durationMs: 1, state: 'ready' });

describe('upcomingArtworkEntries', () => {
  it('takes the next two in Up next and the one Previous returns to', () => {
    const queue = { history: [entry('h1'), entry('h2')], queue: [entry('q1'), entry('q2'), entry('q3')], autoplayQueue: [entry('a1')] };
    expect(upcomingArtworkEntries(queue).map(item => item.id)).toEqual(['q1', 'q2', 'h2']);
  });

  it('runs on into the Autoplay suggestions when Up next is short', () => {
    const queue = { history: [], queue: [entry('q1')], autoplayQueue: [entry('a1'), entry('a2')] };
    expect(upcomingArtworkEntries(queue).map(item => item.id)).toEqual(['q1', 'a1']);
  });

  it('is empty with nothing either side', () => {
    expect(upcomingArtworkEntries({ history: [], queue: [], autoplayQueue: [] })).toEqual([]);
  });
});
