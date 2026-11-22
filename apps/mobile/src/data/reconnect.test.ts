import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { refreshAfterReconnect } from './reconnect';

const pages = (count: number) => ({ pages: Array.from({ length: count }, (_, index) => ({ items: [index] })), pageParams: Array.from({ length: count }, (_, index) => index) });

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const fetched: string[] = [];
  const watch = (key: string[], data: unknown) => {
    queryClient.setQueryData(key, data);
    return new QueryObserver(queryClient, { queryKey: key, queryFn: () => { fetched.push(key.join('/')); return data; } }).subscribe(() => undefined);
  };
  return { queryClient, fetched, watch };
}

describe('refreshAfterReconnect', () => {
  it('refetches what is on screen, except searches, and marks the rest stale', async () => {
    const { queryClient, fetched, watch } = setup();
    watch(['home'], { sections: [] });
    watch(['search', 'library', 'x'], {});
    queryClient.setQueryData(['album', 'a'], { id: 'a' });
    await refreshAfterReconnect(queryClient);
    expect(fetched).toEqual(['home']);
    expect(queryClient.getQueryState(['album', 'a'])?.isInvalidated).toBe(true);
  });

  it('keeps only the first page of a list that is not on screen, and every page of one that is', async () => {
    const { queryClient, watch } = setup();
    queryClient.setQueryData(['likes', 'track'], pages(3));
    const stop = watch(['library', 'tracks'], pages(2));
    vi.spyOn(queryClient, 'refetchQueries').mockResolvedValue();
    await refreshAfterReconnect(queryClient);
    expect(queryClient.getQueryData(['likes', 'track'])).toEqual(pages(1));
    expect(queryClient.getQueryData(['library', 'tracks'])).toEqual(pages(2));
    stop();
  });
});
