import { describe, expect, it } from 'vitest';
import { sortFor, sortsFor } from './sorting';

describe('library sorting', () => {
  it('offers every order for albums, no year for songs, and none for artists and playlists', () => {
    expect(sortsFor('Albums')).toEqual(['Recently added', 'Title', 'Artist', 'Year']);
    expect(sortsFor('Songs')).toEqual(['Recently added', 'Title', 'Artist']);
    expect(sortsFor('Artists')).toEqual([]);
    expect(sortsFor('Playlists')).toEqual([]);
  });

  it('falls back to recently added where the chosen order does not apply', () => {
    expect(sortFor('Albums', 'Year')).toBe('Year');
    expect(sortFor('Songs', 'Year')).toBe('Recently added');
    expect(sortFor('Songs', 'Title')).toBe('Title');
  });
});
