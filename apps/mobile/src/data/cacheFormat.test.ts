import { QueryClient, type DehydratedState } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { decodeSaved, encodeSaved, hydrateSaved, serialiseQueries } from './cacheFormat';

const hour = 3600_000;
const now = 100 * hour;

function query(queryKey: unknown[], data: unknown, dataUpdatedAt = now) {
  return { queryKey, queryHash: JSON.stringify(queryKey), state: { data, dataUpdatedAt, status: 'success' } } as unknown as DehydratedState['queries'][number];
}

const state = (...queries: DehydratedState['queries']): DehydratedState => ({ queries, mutations: [] });
const keysOf = (lines: string[]) => lines.map(line => (JSON.parse(line) as { queryKey: unknown[] }).queryKey);
const limits = { maxQueryLength: 300, maxPagesLength: 500 };

describe('serialiseQueries', () => {
  it('keeps lists apart from detail pages, the most recent pages first', () => {
    const { lists, pages } = serialiseQueries(state(
      query(['album', 'a'], {}, now - 2 * hour),
      query(['home'], { sections: [] }),
      query(['artist', 'b'], {}, now - hour),
      query(['playlists', 'list'], { pages: [], pageParams: [] }),
    ), limits);
    expect(keysOf(lists)).toEqual([['home'], ['playlists', 'list']]);
    expect(keysOf(pages)).toEqual([['artist', 'b'], ['album', 'a']]);
  });

  it('leaves out a query too large to read back quickly', () => {
    const { lists, pages } = serialiseQueries(state(
      query(['artist', 'huge'], { albums: 'x'.repeat(300) }),
      query(['library', 'albums'], { items: 'x'.repeat(300) }),
      query(['album', 'small'], {}),
    ), limits);
    expect(lists).toEqual([]);
    expect(keysOf(pages)).toEqual([['album', 'small']]);
  });

  it('keeps detail pages only up to their total size', () => {
    const page = (id: string, age: number) => query(['album', id], { title: 'x'.repeat(100) }, now - age);
    const { pages } = serialiseQueries(state(page('old', 3 * hour), page('new', hour), page('mid', 2 * hour)), limits);
    expect(keysOf(pages)).toEqual([['album', 'new'], ['album', 'mid']]);
  });
});

describe('encodeSaved and decodeSaved', () => {
  const lines = [JSON.stringify(query(['home'], { text: 'two\nlines' }))];

  it('reads back what was saved for the same account', () => {
    const saved = encodeSaved({ buster: 'me', timestamp: now }, lines);
    expect(decodeSaved(saved, 'me', now + hour, 24 * hour)).toEqual(lines);
    expect(decodeSaved(encodeSaved({ buster: 'me', timestamp: now }, []), 'me', now, hour)).toEqual([]);
  });

  it('refuses another account, an old save and a damaged one', () => {
    const saved = encodeSaved({ buster: 'me', timestamp: now }, lines);
    expect(decodeSaved(saved, 'someone else', now, hour)).toBeUndefined();
    expect(decodeSaved(saved, 'me', now + 2 * hour, hour)).toBeUndefined();
    expect(decodeSaved('{"buster":', 'me', now, hour)).toBeUndefined();
  });
});

describe('hydrateSaved', () => {
  it('adds a saved query, keeps newer data and skips a damaged line', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['album', 'a'], { title: 'fresh' }, { updatedAt: now });
    hydrateSaved(queryClient, JSON.stringify(query(['album', 'a'], { title: 'saved' }, now - hour)));
    hydrateSaved(queryClient, JSON.stringify(query(['home'], { sections: [] }, now - hour)));
    hydrateSaved(queryClient, '{"queryKey":');
    expect(queryClient.getQueryData(['album', 'a'])).toEqual({ title: 'fresh' });
    expect(queryClient.getQueryData(['home'])).toEqual({ sections: [] });
  });
});
