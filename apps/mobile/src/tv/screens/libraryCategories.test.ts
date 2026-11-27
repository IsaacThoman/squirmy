import { describe, expect, it } from 'vitest';
import { categorySort, categorySorts, countLabel, genreCategory, genreOf, listSort } from './libraryCategories';

describe('library categories', () => {
  it('offers Recently played only on All, and no year for songs', () => {
    expect(categorySorts('all')).toEqual(['Recently played', 'Recently added', 'Title', 'Artist', 'Year']);
    expect(categorySorts('albums')).toEqual(['Recently added', 'Title', 'Artist', 'Year']);
    expect(categorySorts('server')).toEqual(['Recently added', 'Title', 'Artist', 'Year']);
    expect(categorySorts('songs')).toEqual(['Recently added', 'Title', 'Artist']);
    expect(categorySorts('artists')).toEqual([]);
    expect(categorySorts('playlists')).toEqual([]);
    expect(categorySorts('genre:Jazz')).toEqual([]);
  });

  it('keeps a chosen order only where the category has it', () => {
    expect(categorySort('all', undefined)).toBe('Recently played');
    expect(categorySort('albums', undefined)).toBe('Recently added');
    expect(categorySort('albums', 'Year')).toBe('Year');
    expect(categorySort('songs', 'Year')).toBe('Recently added');
    expect(categorySort('albums', 'Recently played')).toBe('Recently added');
  });

  it('asks the lists without plays for recently added instead', () => {
    expect(listSort('Recently played')).toBe('recent');
    expect(listSort('Title')).toBe('title');
  });

  it('names genres by their own name', () => {
    expect(genreCategory('Jazz & Soul')).toMatchObject({ id: 'genre:Jazz & Soul', title: 'Jazz & Soul' });
    expect(genreOf('genre:Jazz & Soul')).toBe('Jazz & Soul');
    expect(genreOf('albums')).toBeNull();
  });

  it('counts a list still loading as at least what is in', () => {
    expect(countLabel(1, true, 'album')).toBe('1 album');
    expect(countLabel(14, true, 'album')).toBe('14 albums');
    expect(countLabel(60, false, 'song')).toBe('60+ songs');
  });
});
