import { describe, expect, it } from 'vitest';
import { clipInset, pushedOpacity, restingStop, rowWindow, snapStops, stickyShift } from './queueScroll';

describe('stickyShift', () => {
  const heading = { y: 500, height: 60 };

  it('leaves a heading where it was laid out until it reaches its place at the top', () => {
    expect(stickyShift(0, heading, 0)).toBe(0);
    expect(stickyShift(500, heading, 0)).toBe(0);
    expect(stickyShift(420, heading, 80)).toBe(0);
  });

  it('keeps it pinned below what sticks above it as the page scrolls on', () => {
    expect(stickyShift(700, heading, 0)).toBe(200);
    expect(stickyShift(700, heading, 80)).toBe(280);
  });

  it('lets the next part push it off where its own part ends', () => {
    // Its part ends at 1000: it can go no lower than 940, and then scrolls away with the page.
    expect(stickyShift(850, heading, 80, 1000)).toBe(430);
    expect(stickyShift(900, heading, 80, 1000)).toBe(440);
    expect(stickyShift(2000, heading, 80, 1000)).toBe(440);
  });
});

describe('pushedOpacity', () => {
  const heading = { y: 500, height: 60 };

  it('is opaque while the heading is in its place or below it', () => {
    expect(pushedOpacity(0, heading, 0, 80)).toBe(1);
    expect(pushedOpacity(700, heading, 280, 80)).toBe(1);
  });

  it('fades out over half its height as it is pushed under what is pinned above', () => {
    // Pushed 15 of 60 points up: half way out.
    expect(pushedOpacity(875, heading, 440, 80)).toBeCloseTo(0.5);
    expect(pushedOpacity(950, heading, 440, 80)).toBe(0);
  });
});

describe('clipInset', () => {
  const rows = { y: 560, height: 400 };

  it('cuts nothing while the heading above the rows is where it was laid out', () => {
    expect(clipInset(560, rows)).toBe(0);
    expect(clipInset(300, rows)).toBe(0);
  });

  it('cuts the rows that have gone under the pinned heading, and no more than all of them', () => {
    expect(clipInset(700, rows)).toBe(140);
    expect(clipInset(5000, rows)).toBe(400);
  });
});

describe('snapStops', () => {
  it('rests on the song playing, or a screen up into the history', () => {
    expect(snapStops(2000, 600)).toEqual([1400, 2000]);
  });

  it('stops at the top of a history shorter than a screen', () => {
    expect(snapStops(300, 600)).toEqual([0, 300]);
  });

  it('has nowhere to snap without a history, or before the page is measured', () => {
    expect(snapStops(0, 600)).toEqual([]);
    expect(snapStops(300, 0)).toEqual([]);
  });
});

describe('restingStop', () => {
  const stops = [1400, 2000];

  it('settles between the stops on the nearer one', () => {
    expect(restingStop(1900, stops)).toBe(2000);
    expect(restingStop(1500, stops)).toBe(1400);
  });

  it('leaves the page where it is past the stops, or on one', () => {
    expect(restingStop(2600, stops)).toBeNull();
    expect(restingStop(200, stops)).toBeNull();
    expect(restingStop(2000, stops)).toBeNull();
    expect(restingStop(1700, [])).toBeNull();
  });
});

describe('rowWindow', () => {
  const rows = (count: number, height = 56) => Array.from({ length: count }, () => height);

  it('lays out the rows within a margin of the view, in whole chunks, and keeps the room of the rest', () => {
    // 100 rows from 2000; the view shows 2500 to 3300, so rows 7 to 24 are in reach with a 100 pt
    // margin, and whole chunks of 8 make that rows 0 to 31.
    expect(rowWindow(rows(100), 2000, 2500, 3300, 100, 8)).toEqual({ start: 0, end: 32, above: 0, below: 68 * 56 });
    // Further down, rows 23 to 41 are in reach: rows 16 to 47.
    expect(rowWindow(rows(100), 2000, 3400, 4200, 100, 8)).toEqual({ start: 16, end: 48, above: 16 * 56, below: 52 * 56 });
  });

  it('keeps the list its full height whatever the window', () => {
    const heights = [56, 80, 56, 120, 56, 56, 90, 56, 56, 56, 56, 56];
    const { start, end, above, below } = rowWindow(heights, 0, 150, 260, 0, 2);
    const inside = heights.slice(start, end).reduce((sum, height) => sum + height, 0);
    expect(above + inside + below).toBe(heights.reduce((sum, height) => sum + height, 0));
    expect(start).toBe(2);
    expect(end).toBe(4);
  });

  it('lays out no rows of a list out of reach above or below', () => {
    expect(rowWindow(rows(10), 5000, 0, 800, 800)).toEqual({ start: 0, end: 0, above: 0, below: 560 });
    expect(rowWindow(rows(10), 0, 5000, 5800, 800)).toEqual({ start: 0, end: 0, above: 0, below: 560 });
  });

  it('does not run past the last row', () => {
    expect(rowWindow(rows(10), 0, 300, 1100, 100, 8)).toEqual({ start: 0, end: 10, above: 0, below: 0 });
  });

  it('is empty for an empty list', () => {
    expect(rowWindow([], 0, 0, 800, 800)).toEqual({ start: 0, end: 0, above: 0, below: 0 });
  });
});
