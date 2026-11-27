import type { SearchItem } from '@squirmy/client-core';
import type { ArtistSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { searchRows } from './searchRows';

const artist = (id: string): SearchItem => ({ type: 'artist', artist: { id, name: id } as ArtistSummary });

describe('searchRows', () => {
  it('lays results three to a row under their heading', () => {
    const rows = searchRows({ active: true, title: 'Top results', items: ['a', 'b', 'c', 'd'].map(artist), recents: [artist('x')], genres: ['Jazz'] });
    expect(rows.map(row => row.kind)).toEqual(['heading', 'results', 'results']);
    expect(rows[1]).toMatchObject({ key: 'r:artist:a' });
    expect(rows[2]).toMatchObject({ items: [artist('d')] });
  });

  it('lists nothing for a search without results, so the notice stands alone', () => {
    expect(searchRows({ active: true, title: 'Top results', items: [], recents: [artist('x')], genres: ['Jazz'] })).toEqual([]);
  });

  it('shows what was viewed and the genres before anything is typed', () => {
    const rows = searchRows({ active: false, title: '', items: [], recents: [artist('x')], genres: ['Jazz', 'Rock', 'Pop', 'Folk', 'Soul'] });
    expect(rows.map(row => row.kind)).toEqual(['heading', 'results', 'heading', 'genres', 'genres']);
    expect(rows[0]).toMatchObject({ title: 'Recently viewed', clear: true });
    expect(rows[4]).toMatchObject({ names: ['Soul'], start: 4 });
  });

  it('leaves out an empty history', () => {
    expect(searchRows({ active: false, title: '', items: [], recents: [], genres: ['Jazz'] }).map(row => row.kind)).toEqual(['heading', 'genres']);
  });
});
