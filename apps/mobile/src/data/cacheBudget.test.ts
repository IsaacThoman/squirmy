import type { DehydratedState } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { isDetailKey, withinBudget } from './cacheBudget';

const hour = 3600_000;
const now = 100 * hour;
const budget = { detailMaxAgeMs: 24 * hour, maxDetails: 2 };

function query(queryKey: unknown[], data: unknown, dataUpdatedAt = now) {
  return { queryKey, queryHash: JSON.stringify(queryKey), state: { data, dataUpdatedAt, status: 'success' } } as unknown as DehydratedState['queries'][number];
}

const state = (...queries: DehydratedState['queries']): DehydratedState => ({ queries, mutations: [] });
const keys = (result: DehydratedState) => result.queries.map(item => item.queryKey);

describe('withinBudget', () => {
  it('keeps the first page of a list and nothing after it', () => {
    const pages = { pages: [{ items: [1] }, { items: [2] }, { items: [3] }], pageParams: [undefined, 'a', 'b'] };
    const [liked] = withinBudget(state(query(['likes', 'track'], pages)), now, budget).queries;
    expect(liked!.state.data).toEqual({ pages: [{ items: [1] }], pageParams: [undefined] });
  });

  it('leaves data that is not paged as it is', () => {
    const home = query(['home'], { sections: [] });
    expect(withinBudget(state(home), now, budget).queries[0]).toBe(home);
  });

  it('keeps only the most recent detail pages, and none older than the limit', () => {
    const result = withinBudget(state(
      query(['album', 'old'], {}, now - 25 * hour),
      query(['album', 'a'], {}, now - 3 * hour),
      query(['artist', 'b'], {}, now - 1 * hour),
      query(['playlists', 'c'], {}, now - 2 * hour),
      query(['playlists', 'list'], { pages: [], pageParams: [] }, now - 50 * hour),
      query(['settings'], {}, now - 50 * hour),
    ), now, budget);
    expect(keys(result)).toEqual([['artist', 'b'], ['playlists', 'c'], ['playlists', 'list'], ['settings']]);
  });
});

describe('isDetailKey', () => {
  it('tells pages of one item from lists', () => {
    expect([['album', 'x'], ['artist', 'x'], ['track', 'x'], ['playlists', 'x']].every(isDetailKey)).toBe(true);
    expect([['playlists', 'list'], ['likes', 'track'], ['home'], ['library', 'albums', 'recent']].some(isDetailKey)).toBe(false);
  });
});
