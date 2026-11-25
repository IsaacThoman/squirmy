import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { chunk, pressVerb, sameRow, songRows } from './rows';

const track = (id: string, position: number | null = null) => ({ id, position } as TrackSummary);

describe('songRows', () => {
  it('marks the rows that open their album when they can’t play: only in a list that asks, and only with an album', () => {
    const tracks = [{ id: 'a', album: { id: 'al', title: 'Album', artwork: null } }, { id: 'b', album: null }] as unknown as TrackSummary[];
    expect(songRows({ tracks, opens: true }).map(row => row.opens)).toEqual([true, false]);
    expect(songRows({ tracks }).map(row => row.opens)).toEqual([false, false]);
    expect(sameRow(songRows({ tracks, opens: true })[0]!, songRows({ tracks })[0]!)).toBe(false);
  });

  it('keys rows by track and index, numbering by album position', () => {
    const rows = songRows({ tracks: [track('a', 3), track('a')], numbered: true });
    expect(rows.map(row => [row.key, row.number])).toEqual([['a:0', 3], ['a:1', 2]]);
    expect(rows[0]!.playlist).toBeUndefined();
  });

  it('keys a playlist’s rows by item, so moving one keeps it', () => {
    const playlist = { id: 'p', itemIds: ['i1', 'i2'], editing: false, onMove: () => undefined, onRemove: () => undefined };
    const rows = songRows({ tracks: [track('a'), track('b')], playlist });
    expect(rows.map(row => row.key)).toEqual(['i1', 'i2']);
    expect(rows[1]!.playlist).toEqual({ id: 'p', itemId: 'i2' });
  });
});

describe('sameRow', () => {
  it('compares what a row shows, not the object', () => {
    const tracks = [track('a')];
    const [first] = songRows({ tracks });
    const [again] = songRows({ tracks });
    expect(sameRow(first!, again!)).toBe(true);
    expect(sameRow(first!, songRows({ tracks: [track('a')] })[0]!)).toBe(false);
  });
});

describe('chunk', () => {
  it('splits into rows, the last one shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('pressVerb', () => {
  it('says the current song pauses or resumes, and any other plays', () => {
    expect([pressVerb('playing'), pressVerb('paused'), pressVerb(null)]).toEqual(['Pause', 'Resume', 'Play']);
  });
});
