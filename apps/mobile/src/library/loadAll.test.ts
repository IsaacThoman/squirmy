import { describe, expect, it, vi } from 'vitest';
import { loadRest } from './loadAll';

describe('loadRest', () => {
  it('fetches the pages after the loaded ones until the list ends', async () => {
    const fetchPage = vi.fn(async (cursor: string) => cursor === 'a'
      ? { items: [3, 4], nextCursor: 'b' }
      : { items: [5], nextCursor: null });
    expect(await loadRest([1, 2], 'a', fetchPage)).toEqual([1, 2, 3, 4, 5]);
    expect(fetchPage.mock.calls).toEqual([['a', 200], ['b', 200]]);
  });

  it('stops at the limit', async () => {
    const fetchPage = vi.fn(async () => ({ items: [3, 4, 5], nextCursor: 'more' }));
    expect(await loadRest([1, 2], 'a', fetchPage, 4)).toEqual([1, 2, 3, 4]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('makes no request when everything is loaded', async () => {
    const fetchPage = vi.fn();
    expect(await loadRest([1], null, fetchPage)).toEqual([1]);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
