import { describe, expect, it } from 'vitest';
import { reachedEnd, rubberBand, scrubPoint, seekLanded, startScrub, stretchLimit } from './scrub';

describe('scrubPoint', () => {
  it('moves the value by how far the finger moves, from where it was', () => {
    expect(scrubPoint(100, 0, 300, 200)).toEqual({ value: 100, stretch: 0 });
    expect(scrubPoint(100, 30, 300, 200).value).toBeCloseTo(120);
    expect(scrubPoint(100, -60, 300, 200).value).toBeCloseTo(60);
  });

  it('covers the whole range in a drag across the whole width', () => {
    expect(scrubPoint(0, 300, 300, 180_000).value).toBe(180_000);
    expect(scrubPoint(180_000, -300, 300, 180_000).value).toBe(0);
  });

  it('runs the other way right to left', () => {
    expect(scrubPoint(100, -30, 300, 200, true).value).toBeCloseTo(120);
  });

  it('stops at the ends and stretches past them, left past the start and right past the end', () => {
    const start = scrubPoint(10, -100, 300, 200);
    expect(start.value).toBe(0);
    expect(start.stretch).toBeLessThan(0);
    const end = scrubPoint(190, 100, 300, 200);
    expect(end.value).toBe(200);
    expect(end.stretch).toBeGreaterThan(0);
  });

  it('stretches toward the start’s side right to left', () => {
    expect(scrubPoint(10, 100, 300, 200, true).stretch).toBeGreaterThan(0);
  });

  it('keeps the value without a width or a range', () => {
    expect(scrubPoint(50, 80, 0, 200)).toEqual({ value: 50, stretch: 0 });
    expect(scrubPoint(50, 80, 300, 0)).toEqual({ value: 0, stretch: 0 });
  });
});

describe('rubberBand', () => {
  it('is nothing without an overshoot', () => {
    expect(rubberBand(0)).toBe(0);
  });

  it('gives less than the finger moved, more for further, and never reaches the limit', () => {
    const near = rubberBand(10);
    const far = rubberBand(100);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(10);
    expect(far).toBeGreaterThan(near);
    expect(rubberBand(100_000)).toBeLessThan(stretchLimit);
    expect(rubberBand(100_000)).toBeGreaterThan(stretchLimit * 0.99);
  });

  it('is symmetric', () => {
    expect(rubberBand(-40)).toBeCloseTo(-rubberBand(40));
  });
});

describe('reachedEnd', () => {
  it('is true only on arriving at an end', () => {
    expect(reachedEnd(5, 0, 100)).toBe(true);
    expect(reachedEnd(95, 100, 100)).toBe(true);
    expect(reachedEnd(0, 0, 100)).toBe(false);
    expect(reachedEnd(100, 100, 100)).toBe(false);
    expect(reachedEnd(5, 6, 100)).toBe(false);
  });
});

describe('startScrub', () => {
  it('commits nothing for a touch that never moves, such as a tap', () => {
    expect(startScrub(40, 300, 100).release()).toBeNull();
    const still = startScrub(40, 300, 100);
    still.move(0);
    expect(still.release()).toBeNull();
  });

  it('commits where the drag left the value', () => {
    const scrub = startScrub(40, 300, 100);
    scrub.move(30);
    scrub.move(60);
    expect(scrub.release()).toBeCloseTo(60);
  });

  it('commits nothing for a cancelled drag', () => {
    const scrub = startScrub(40, 300, 100);
    scrub.move(60);
    expect(scrub.release(true)).toBeNull();
  });

  it('reports reaching an end once, not again while it stays there', () => {
    const scrub = startScrub(90, 300, 100);
    expect(scrub.move(15).reachedEnd).toBe(false);
    expect(scrub.move(60).reachedEnd).toBe(true);
    expect(scrub.move(90).reachedEnd).toBe(false);
    expect(scrub.move(0).reachedEnd).toBe(false);
    expect(scrub.move(60).reachedEnd).toBe(true);
  });

  it('does not report the end it started at', () => {
    expect(startScrub(0, 300, 100).move(-30).reachedEnd).toBe(false);
  });
});

describe('seekLanded', () => {
  it('waits for a position near the seek', () => {
    expect(seekLanded(10_000, 60_000)).toBe(false);
    expect(seekLanded(60_400, 60_000)).toBe(true);
  });
});
