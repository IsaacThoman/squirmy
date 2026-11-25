import { describe, expect, it } from 'vitest';
import { defaultSort, serverDefaultSort, serverSort, serverSortNames, sortNames, sortOptions } from './sorting';

describe('library sorting', () => {
  it('opens in recently played order and offers all five collection sorts', () => {
    expect(sortOptions[defaultSort]).toBe('played');
    expect(sortNames).toEqual(['Recently played', 'Recently added', 'Title', 'Artist', 'Year']);
  });

  it('sorts the server’s albums as the album lists do, newest first', () => {
    expect(serverSortNames).toEqual(['Recently added', 'Title', 'Artist', 'Year']);
    expect(serverSort(serverDefaultSort)).toBe('recent');
    expect(serverSortNames.map(serverSort)).toEqual(['recent', 'title', 'artist', 'year']);
  });
});
