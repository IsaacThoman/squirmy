import { describe, expect, it } from 'vitest';
import { sortFor, sortsFor } from './sorting';

describe('library sorting', () => {
  it('offers every order for albums, no year for songs, and none for artists and playlists', () => {
    expect(sortsFor('Albums')).toEqual(['Recently added', 'Title', 'Artist', 'Year']);
    expect(sortsFor('Songs')).toEqual(['Recently added', 'Title', 'Artist']);
    expect(sortsFor('Artists')).toEqual([]);
    expect(sortsFor('Playlists')).toEqual([]);
  });

  it('keeps the order chosen under each filter apart', () => {
    const chosen = { Songs: 'Title', Albums: 'Year' } as const;
    expect(sortFor('Songs', chosen)).toBe('Title');
    expect(sortFor('Albums', chosen)).toBe('Year');
    expect(sortFor('All', chosen)).toBe('Recently added');
  });

  it('falls back to recently added where nothing, or an order that does not apply, was chosen', () => {
    expect(sortFor('Songs', {})).toBe('Recently added');
    expect(sortFor('Songs', { Songs: 'Year' })).toBe('Recently added');
    expect(sortFor('Artists', { Artists: 'Title' })).toBe('Recently added');
  });
});
