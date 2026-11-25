import type { AlbumSummary, LibraryItem } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { emptyLibrary, emptyServer, listsNothing } from './libraryEmpty';

const liked = { kind: 'liked' } as LibraryItem;
const album = { kind: 'album', album: { id: 'a' } } as LibraryItem;

describe('listsNothing', () => {
  it('is a new library: Liked Songs alone, or nothing', () => {
    expect(listsNothing({ server: false, items: [liked] })).toBe(true);
    expect(listsNothing({ server: false, items: [] })).toBe(true);
  });

  it('is not once something was saved', () => {
    expect(listsNothing({ server: false, items: [liked, album] })).toBe(false);
  });

  it('is a server without albums, On this server', () => {
    expect(listsNothing({ server: true, items: [] })).toBe(true);
    expect(listsNothing({ server: true, items: [{ id: 'a' } as AlbumSummary] })).toBe(false);
  });
});

describe('empty wording', () => {
  it('says the library is your saves and uploads, and points to the server’s music and the heart', () => {
    expect(emptyLibrary.description).not.toMatch(/stored on your server/);
    expect(emptyLibrary.description).toMatch(/you upload/);
    expect(emptyLibrary.description).toMatch(/on this server/);
    expect(emptyLibrary.description).toMatch(/heart/);
  });

  it('says what On this server would list, as on web', () => {
    expect(emptyServer.title).toBe('Nothing on this server yet');
  });
});
