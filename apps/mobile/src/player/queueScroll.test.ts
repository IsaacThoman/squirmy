import { describe, expect, it } from 'vitest';
import { clipInset, pushedOpacity, restingStop, snapStops, stickyShift } from './queueScroll';

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
