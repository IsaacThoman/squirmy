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

  it('lists artists after the other collections, under an Artists heading, and before the songs', () => {
    const rows = libraryRows({ mode: 'grid', items: [item('a')], artists: [item('r1'), item('r2'), item('r3')], songs, columns: 2 });
    expect(rows.map(row => row.kind)).toEqual(['tiles', 'heading', 'tiles', 'tiles', 'heading', 'song']);
    expect(rows[1]).toMatchObject({ title: 'Artists' });
    expect(rows[4]).toMatchObject({ title: 'Songs' });
    expect(libraryRows({ mode: 'list', items: [], artists: [item('r1')], songs: [], columns: 2 }).map(row => row.kind)).toEqual(['heading', 'row']);
  });

  it('has no heading without songs, or under Songs', () => {
    expect(libraryRows({ mode: 'list', items: [item('a')], songs: [], columns: 3 }).map(row => row.kind)).toEqual(['row']);
    expect(libraryRows({ mode: 'songs', items: [], songs, columns: 3 }).map(row => row.kind)).toEqual(['song']);
  });
});
