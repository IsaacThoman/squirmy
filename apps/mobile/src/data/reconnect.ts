import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query';

/** Answers that do not change while the app is away, or that are asked again anyway. */
const unchanging = new Set(['search', 'lyrics', 'track']);

const isPaged = (data: unknown): data is InfiniteData<unknown> =>
  Boolean(data && typeof data === 'object' && Array.isArray((data as InfiniteData<unknown>).pages));

/**
 * The socket was down, so `invalidate` messages may have been missed. Everything is marked
 * stale, so each screen refetches when it is next shown; only the screens showing now
 * refetch at once, except searches and lyrics. A list that is not on screen keeps just its
 * first page, so showing it again is one request rather than one per page loaded before.
 */
export function refreshAfterReconnect(queryClient: QueryClient): Promise<void> {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data;
    if (query.isActive() || !isPaged(data) || data.pages.length <= 1) continue;
    queryClient.setQueryData(query.queryKey, { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
      { updatedAt: query.state.dataUpdatedAt });
  }
  return queryClient.invalidateQueries({
    refetchType: 'none',
  }).then(() => queryClient.refetchQueries({
    type: 'active',
    predicate: (query: Query) => !unchanging.has(String(query.queryKey[0])),
  }));
}
