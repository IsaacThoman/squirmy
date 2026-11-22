import type { SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { inLibraryOnly } from './librarySearch';

const track = (id: string, inLibrary?: boolean) => ({ id, inLibrary }) as TrackSummary;

describe('inLibraryOnly', () => {
  it('keeps songs and artists in the library, and songs from servers that do not say', () => {
    const results = {
      artists: [{ id: 'in', inLibrary: true }, { id: 'out', inLibrary: false }],
      albums: [{ id: 'album' }],
      tracks: [track('saved', true), track('played', false), track('older')],
      provider: null,
    } as SearchResults;
    const kept = inLibraryOnly(results);
    expect(kept.artists.map(item => item.id)).toEqual(['in']);
    expect(kept.tracks.map(item => item.id)).toEqual(['saved', 'older']);
    expect(kept.albums).toBe(results.albums);
  });
});
