import type { TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { libraryRows } from './libraryRows';
import { songRows } from './rows';
import type { Collection } from './shared';

const item = (key: string) => ({ key, title: key }) as unknown as Collection;
const songs = songRows({ tracks: [{ id: 't1', title: 'Song' } as unknown as TrackSummary] });

describe('libraryRows', () => {
  it('lists the songs found after the collections, under a Songs heading', () => {
    const rows = libraryRows({ mode: 'grid', items: [item('a'), item('b'), item('c')], songs, columns: 2 });
    expect(rows.map(row => row.kind)).toEqual(['tiles', 'tiles', 'heading', 'song']);
    expect(rows[2]).toMatchObject({ title: 'Songs' });
  });

  it('shows the songs alone when no collection matched', () => {
    expect(libraryRows({ mode: 'list', items: [], songs, columns: 3 }).map(row => row.kind)).toEqual(['heading', 'song']);
  });

  it('keeps artists among the other collections, with no heading of their own, before the songs', () => {
    const rows = libraryRows({ mode: 'grid', items: [item('r1'), item('a'), item('r2')], songs, columns: 2 });
    expect(rows.map(row => row.kind)).toEqual(['tiles', 'tiles', 'heading', 'song']);
    expect(rows.filter(row => row.kind === 'heading')).toEqual([expect.objectContaining({ title: 'Songs' })]);
  });

  it('has no heading without songs, or under Songs', () => {
    expect(libraryRows({ mode: 'list', items: [item('a')], songs: [], columns: 3 }).map(row => row.kind)).toEqual(['row']);
    expect(libraryRows({ mode: 'songs', items: [], songs, columns: 3 }).map(row => row.kind)).toEqual(['song']);
  });
});
