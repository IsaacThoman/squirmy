import type { QueueEntry } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  landedPage, nextEntry, previousEntry, rubberBand, rubberBandLimit, skipCommits, skipDirection, skipDistance, swipeOffset,
} from './skipSwipe';

const entry = (id: string, extra: Partial<QueueEntry> = {}): QueueEntry => ({ id, trackId: `t-${id}`, albumId: null, durationMs: 1000, state: 'ready', ...extra });

const session = (extra: Partial<Parameters<typeof nextEntry>[0]> = {}): Parameters<typeof nextEntry>[0] => ({
  current: entry('now'), repeat: 'off', autoplay: false, queue: [], autoplayQueue: [], playedInCycle: [], ...extra,
});

describe('skipCommits', () => {
  it('needs a slow swipe to travel past the distance', () => {
    expect(skipCommits(-skipDistance, -100)).toBe(false);
    expect(skipCommits(-skipDistance - 1, -100)).toBe(true);
    expect(skipCommits(skipDistance + 1, 0)).toBe(true);
  });

  it('takes a short flick that is fast enough', () => {
    expect(skipCommits(-30, -800)).toBe(true);
    expect(skipCommits(30, 800)).toBe(true);
    expect(skipCommits(-30, -500)).toBe(false);
    expect(skipCommits(-15, -2000)).toBe(false);
  });

  it('is called off by a fling back the other way, however far it went', () => {
    expect(skipCommits(-120, 400)).toBe(false);
    expect(skipCommits(120, -400)).toBe(false);
    expect(skipCommits(-120, 200)).toBe(true);
    expect(skipCommits(-30, 800)).toBe(false);
  });

  it('is nothing without travel', () => {
    expect(skipCommits(0, 5000)).toBe(false);
  });
});

describe('skipDirection', () => {
  it('plays the next song for a swipe to the left and the one before for a swipe to the right', () => {
    expect(skipDirection(-10)).toBe(1);
    expect(skipDirection(10)).toBe(-1);
  });
});

describe('rubberBand', () => {
  it('gives less the further it is pulled, and never reaches the limit', () => {
    const steps = [10, 40, 100, 400, 4000].map(offset => rubberBand(offset));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
      expect(steps[i]! - steps[i - 1]!).toBeLessThan([10, 40, 100, 400, 4000][i]! - [10, 40, 100, 400, 4000][i - 1]!);
    }
    expect(steps.at(-1)!).toBeLessThan(rubberBandLimit);
    expect(rubberBand(10)).toBeLessThan(10);
  });

  it('keeps the direction and rests at zero', () => {
    expect(rubberBand(-100)).toBeCloseTo(-rubberBand(100));
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(50, 0)).toBe(0);
  });
});

describe('swipeOffset', () => {
  it('follows the finger towards a song, up to a page', () => {
    expect(swipeOffset(-80, 240, true, false)).toBe(-80);
    expect(swipeOffset(-300, 240, true, false)).toBe(-240);
    expect(swipeOffset(90, 240, false, true)).toBe(90);
  });

  it('only gives a little towards no song', () => {
    expect(swipeOffset(80, 240, true, false)).toBe(rubberBand(80));
    expect(swipeOffset(-80, 240, false, true)).toBe(rubberBand(-80));
  });
});

describe('nextEntry', () => {
  it('is the queue’s first playable entry, which with shuffle is already the shuffled one', () => {
    expect(nextEntry(session({ queue: [entry('a', { state: 'failed' }), entry('b'), entry('c')] }))?.id).toBe('b');
  });

  it('starts a new cycle with repeat all once the queue is done, leaving out what was added with Play next', () => {
    const played = [entry('p1', { queued: true }), entry('p2'), entry('p3')];
    expect(nextEntry(session({ repeat: 'all', playedInCycle: played }))?.id).toBe('p2');
    expect(nextEntry(session({ repeat: 'all' }))?.id).toBe('now');
  });

  it('goes on to Autoplay’s suggestions when Autoplay is on', () => {
    const autoplayQueue = [entry('s1', { state: 'failed' }), entry('s2')];
    expect(nextEntry(session({ autoplay: true, autoplayQueue }))?.id).toBe('s2');
    expect(nextEntry(session({ autoplay: false, autoplayQueue }))).toBeNull();
  });

  it('skips to the next song with repeat one rather than the same one', () => {
    expect(nextEntry(session({ repeat: 'one', queue: [entry('b')] }))?.id).toBe('b');
    expect(nextEntry(session({ repeat: 'one' }))).toBeNull();
  });

  it('is null at the end of the queue, and with nothing playing', () => {
    expect(nextEntry(session())).toBeNull();
    expect(nextEntry(session({ current: null, queue: [entry('b')] }))).toBeNull();
  });
});

describe('previousEntry', () => {
  it('is the last playable entry behind the current one in this cycle', () => {
    expect(previousEntry(session({ playedInCycle: [entry('a'), entry('b'), entry('c', { state: 'failed' })] }))?.id).toBe('b');
  });

  it('is null at the start of the cycle and with nothing playing', () => {
    expect(previousEntry(session())).toBeNull();
    expect(previousEntry(session({ current: null, playedInCycle: [entry('a')] }))).toBeNull();
  });
});

describe('landedPage', () => {
  it('stays on its page while the song does', () => {
    expect(landedPage({ id: 'a', page: 3 }, 'a', { from: 'a', direction: 1 })).toBe(3);
  });

  it('moves a page along with a skip from the song it shows', () => {
    expect(landedPage({ id: 'a', page: 3 }, 'b', { from: 'a', direction: 1 })).toBe(4);
    expect(landedPage({ id: 'a', page: 3 }, 'z', { from: 'a', direction: -1 })).toBe(2);
  });

  it('keeps its page for a song that changed some other way', () => {
    expect(landedPage({ id: 'a', page: 3 }, 'b', null)).toBe(3);
    expect(landedPage({ id: 'a', page: 3 }, 'c', { from: 'x', direction: 1 })).toBe(3);
  });
});
