import { hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import { isDetailKey } from './cacheBudget';

type DehydratedQuery = DehydratedState['queries'][number];

export type SaveLimits = {
  /** A query whose JSON is longer than this is not saved. */
  maxQueryLength: number;
  /** The detail pages saved together stay within this, the most recently loaded first. */
  maxPagesLength: number;
};

/**
 * One artist with thousands of releases can be megabytes, and reading it back would hold the
 * launch for one page, so a query over 512 KB (characters of JSON, about bytes) is not saved
 * and is fetched again when opened. The detail pages together stay within 4 MB, so reading
 * them after launch stays short too.
 */
export const saveLimits: SaveLimits = { maxQueryLength: 512 * 1024, maxPagesLength: 4 * 1024 * 1024 };

/** The two halves of the saved cache, each one line of JSON per query. */
export type SavedQueries = { lists: string[]; pages: string[] };

/**
 * Splits the queries to save into lists, which the first screen needs and are read before
 * it shows, and detail pages (album, artist, playlist, track), which are read after it. Each
 * query is serialised on its own, so it can be measured, and read back without one large
 * `JSON.parse` holding the JS thread.
 */
export function serialiseQueries(state: DehydratedState, limits: SaveLimits = saveLimits): SavedQueries {
  const lists: string[] = [];
  const details: { json: string; updatedAt: number }[] = [];
  for (const query of state.queries) {
    const json = JSON.stringify(query);
    if (json.length > limits.maxQueryLength) continue;
    if (isDetailKey(query.queryKey)) details.push({ json, updatedAt: query.state.dataUpdatedAt });
    else lists.push(json);
  }
  details.sort((a, b) => b.updatedAt - a.updatedAt);
  const pages: string[] = [];
  let length = 0;
  for (const { json } of details) {
    if (length + json.length > limits.maxPagesLength) break;
    length += json.length;
    pages.push(json);
  }
  return { lists, pages };
}

type Header = { buster: string; timestamp: number };

/**
 * A header line, then one query per line. `JSON.stringify` escapes line breaks inside
 * strings, so a line break only ever ends a query.
 */
export function encodeSaved(header: Header, queries: readonly string[]): string {
  return [JSON.stringify(header), ...queries].join('\n');
}

/**
 * The queries saved for `buster` no longer ago than `maxAgeMs`, still serialised. Undefined
 * when the saved value belongs to another account, is too old or cannot be read, so it can
 * be removed.
 */
export function decodeSaved(saved: string, buster: string, now: number, maxAgeMs: number): string[] | undefined {
  const lines = saved.split('\n');
  try {
    const header = JSON.parse(lines[0]!) as Partial<Header>;
    if (header.buster !== buster || typeof header.timestamp !== 'number' || now - header.timestamp > maxAgeMs) return undefined;
  } catch {
    return undefined;
  }
  return lines.slice(1).filter(line => line.length > 0);
}

/**
 * Adds one saved query to `queryClient`. Data loaded meanwhile is newer and is kept, which
 * `hydrate` sees to; a line that cannot be read is skipped.
 */
export function hydrateSaved(queryClient: QueryClient, line: string): void {
  try {
    hydrate(queryClient, { queries: [JSON.parse(line) as DehydratedQuery], mutations: [] });
  } catch {
    // A damaged line: that page loads as if it was never saved.
  }
}
