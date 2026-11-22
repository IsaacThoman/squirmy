import type { Page } from '@squirmy/contracts';

/** The most tracks one play command takes (the session's seed limit). */
export const maxPlayed = 5000;
/** The largest page the server sends. */
const bulkPageSize = 200;

export type FetchPage<T> = (cursor: string, limit: number) => Promise<Page<T>>;

/**
 * `loaded` and the pages after `cursor`, until the list ends or `limit` items are in hand.
 * Lists on screen load 60 at a time as they scroll; playing one needs the rest, fetched in
 * the largest pages the server allows.
 */
export async function loadRest<T>(loaded: readonly T[], cursor: string | null | undefined, fetchPage: FetchPage<T>, limit = maxPlayed): Promise<T[]> {
  const items = [...loaded];
  let next = cursor ?? null;
  while (next && items.length < limit) {
    const page = await fetchPage(next, bulkPageSize);
    items.push(...page.items);
    next = page.nextCursor;
  }
  return items.slice(0, limit);
}

