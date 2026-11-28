import type { QueueEntry } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  canIdle, carouselSlots, containerTitle, elapsedLeft, inkFrom, progressOf, seekStep, slideFrom, statusLine, steppedPosition, togglePanel,
} from './model';

const entry = (id: string): QueueEntry => ({ id, trackId: `t-${id}`, albumId: null, durationMs: 1000, state: 'ready' });
const ids = (slots: ReturnType<typeof carouselSlots>) => slots.map(slot => `${slot.offset}:${slot.entry.id}`);

describe('carouselSlots', () => {
  const queue = { history: [entry('h1'), entry('h2'), entry('h3')], queue: [entry('q1')], autoplayQueue: [entry('a1'), entry('a2')] };

  it('lines up the last songs played, the one playing and what plays next', () => {
    expect(ids(carouselSlots({ current: entry('c'), autoplay: false }, queue))).toEqual(['-2:h2', '-1:h3', '0:c', '1:q1']);
  });

  it('follows the queue with the autoplay suggestions while autoplay is on', () => {
    expect(ids(carouselSlots({ current: entry('c'), autoplay: true }, queue))).toEqual(['-2:h2', '-1:h3', '0:c', '1:q1', '2:a1']);
  });

  it('shows nothing while nothing plays', () => {
    expect(carouselSlots({ current: null, autoplay: true }, queue)).toEqual([]);
  });
});

describe('slideFrom', () => {
  const before = carouselSlots({ current: entry('c'), autoplay: false }, { history: [entry('h')], queue: [entry('n')], autoplayQueue: [] });

  it('slides from the right when playback moves on, and from the left when it goes back', () => {
    expect(slideFrom(before, 'n')).toBe(1);
    expect(slideFrom(before, 'h')).toBe(-1);
  });

  it('does not slide to a song that was not in view', () => {
    expect(slideFrom(before, 'elsewhere')).toBe(0);
    expect(slideFrom(before, undefined)).toBe(0);
  });
});

describe('the remote and the playhead', () => {
  it('moves ten seconds a press and thirty while held', () => {
    expect(seekStep('right')).toBe(10_000);
    expect(seekStep('left')).toBe(-10_000);
    expect(seekStep('longRight')).toBe(30_000);
    expect(seekStep('select')).toBeNull();
  });

  it('keeps the playhead inside the song', () => {
    expect(steppedPosition(5_000, -10_000, 200_000)).toBe(0);
    expect(steppedPosition(195_000, 10_000, 200_000)).toBe(200_000);
    expect(steppedPosition(50_000, 10_000, 200_000)).toBe(60_000);
  });

  it('does not move in a song of unknown length', () => {
    expect(steppedPosition(5_000, 10_000, 0)).toBe(5_000);
  });

  it('measures progress between 0 and 1', () => {
    expect(progressOf(50, 200)).toBe(0.25);
    expect(progressOf(500, 200)).toBe(1);
    expect(progressOf(5, 0)).toBe(0);
  });

  it('centres the elapsed time under the playhead without leaving the bar', () => {
    expect(elapsedLeft(0.5, 1000, 100)).toBe(450);
    expect(elapsedLeft(0, 1000, 100)).toBe(0);
    expect(elapsedLeft(1, 1000, 100)).toBe(900);
  });
});

describe('containerTitle', () => {
  it('names what the music was started from, or the song’s album', () => {
    expect(containerTitle({ type: 'playlist', id: 'p', title: 'Road trip' }, 'Album')).toBe('Road trip');
    expect(containerTitle({ type: 'other', id: null, title: null }, 'Album')).toBe('Album');
    expect(containerTitle(null, undefined)).toBe('');
  });
});

describe('statusLine', () => {
  const calm = { notice: null, slow: false, remote: false, where: 'Playing on Isaac’s iPhone', detached: false };

  it('says nothing while all is well here', () => {
    expect(statusLine(calm)).toBeNull();
  });

  it('puts what playback reports first, then a slow song, then where it plays', () => {
    expect(statusLine({ ...calm, notice: { message: 'Skipped “Song”', detail: 'Not available' }, slow: true, remote: true }))
      .toEqual({ text: 'Skipped “Song”', detail: 'Not available', tone: 'notice' });
    expect(statusLine({ ...calm, slow: true, remote: true })).toEqual({ text: 'Still loading…', tone: 'quiet' });
    expect(statusLine({ ...calm, remote: true })).toEqual({ text: 'Playing on Isaac’s iPhone', tone: 'quiet' });
    expect(statusLine({ ...calm, detached: true })).toEqual({ text: 'Only on this Apple TV', tone: 'quiet' });
  });
});

describe('panels and idling', () => {
  it('opens a panel, switches to the other, and closes the one open', () => {
    expect(togglePanel('none', 'lyrics')).toBe('lyrics');
    expect(togglePanel('lyrics', 'queue')).toBe('queue');
    expect(togglePanel('queue', 'queue')).toBe('none');
  });

  it('lets the controls fade only while music plays and the queue is closed', () => {
    expect(canIdle({ playing: true, panel: 'none', failed: false })).toBe(true);
    expect(canIdle({ playing: true, panel: 'lyrics', failed: false })).toBe(true);
    expect(canIdle({ playing: false, panel: 'none', failed: false })).toBe(false);
    expect(canIdle({ playing: true, panel: 'queue', failed: false })).toBe(false);
    expect(canIdle({ playing: true, panel: 'none', failed: true })).toBe(false);
  });
});

describe('inkFrom', () => {
  it('lightens the cover’s colour toward white', () => {
    expect(inkFrom('#000000', 0.5)).toBe('#808080');
    expect(inkFrom('#FF0000', 0.75)).toBe('#ffbfbf');
    expect(inkFrom('#123456', 0)).toBe('#123456');
  });

  it('has nothing for a cover without a colour', () => {
    expect(inkFrom(null, 0.5)).toBeNull();
    expect(inkFrom('red', 0.5)).toBeNull();
  });
});
