import { describe, expect, it } from 'vitest';
import { defaultSort, sortNames, sortOptions } from './sorting';

describe('library sorting', () => {
  it('opens in recently played order and offers all five collection sorts', () => {
    expect(sortOptions[defaultSort]).toBe('played');
    expect(sortNames).toEqual(['Recently played', 'Recently added', 'Title', 'Artist', 'Year']);
  });
});
