import type { DehydratedState } from '@tanstack/react-query';

type DehydratedQuery = DehydratedState['queries'][number];

/** Pages one item opens (an album, an artist, a playlist, a track), as opposed to lists every launch shows. */
export function isDetailKey(key: readonly unknown[]): boolean {
  const [root, id] = key;
  return root === 'album' || root === 'artist' || root === 'track' || (root === 'playlists' && id !== 'list');
}

export type CacheBudget = {
  /** Detail pages older than this are not kept. */
  detailMaxAgeMs: number;
  /** At most this many detail pages are kept, the most recently loaded first. */
  maxDetails: number;
};

/**
 * What is worth saving for the next launch, so the saved cache stays small enough to read
 * and write without a pause: lists keep their first page (the rest load as the user scrolls,
 * as they do on any refetch), and only the detail pages loaded lately are kept.
 */
export function withinBudget(state: DehydratedState, now: number, budget: CacheBudget): DehydratedState {
  const details = state.queries
    .filter(query => isDetailKey(query.queryKey) && now - query.state.dataUpdatedAt <= budget.detailMaxAgeMs)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, budget.maxDetails);
  const keptDetails = new Set(details);
  const queries = state.queries
    .filter(query => !isDetailKey(query.queryKey) || keptDetails.has(query))
    .map(firstPageOnly);
  return { ...state, queries };
}

function firstPageOnly(query: DehydratedQuery): DehydratedQuery {
  const data = query.state.data as { pages?: unknown; pageParams?: unknown } | undefined;
  if (!data || !Array.isArray(data.pages) || !Array.isArray(data.pageParams) || data.pages.length <= 1) return query;
  return {
    ...query,
    state: { ...query.state, data: { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } },
  };
}
