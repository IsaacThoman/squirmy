import type { AlbumSummary, SearchResults, TrackSummary } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { inLibraryOnly, libraryAlbumMatches, shownMatches } from './librarySearch';

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

describe('libraryAlbumMatches', () => {
  const album = (id: string, liked?: boolean) => ({ id, liked }) as AlbumSummary;
  const found = [album('listed', false), album('played', false), album('saved', true), album('older')];

  it('keeps the albums the library lists, and those saved since it was read', () => {
    expect(libraryAlbumMatches(found, { ids: ['listed', 'other'], complete: true }).map(item => item.id)).toEqual(['listed', 'saved']);
  });

  it('shows none until the list is in, and all when it could not be read to its end', () => {
    expect(libraryAlbumMatches(found, undefined)).toEqual([]);
    expect(libraryAlbumMatches(found, { ids: ['listed'], complete: false })).toEqual(found);
  });
});

describe('shownMatches', () => {
  const results = {
    artists: [{ id: 'saved', inLibrary: true }, { id: 'server', inLibrary: false }],
    albums: [{ id: 'hearted', liked: true }, { id: 'server', liked: false }],
    tracks: [track('saved', true), track('server', false)],
    provider: null,
  } as SearchResults;

  it('keeps the Library to what is in it: a fresh library finds only its saves', () => {
    const shown = shownMatches(results, 'library', { ids: [], complete: true });
    expect(shown.artists.map(item => item.id)).toEqual(['saved']);
    expect(shown.albums.map(item => item.id)).toEqual(['hearted']);
    expect(shown.tracks.map(item => item.id)).toEqual(['saved']);
  });

  it('shows On this server everything the server found', () => {
    expect(shownMatches(results, 'server', undefined)).toBe(results);
  });
});
