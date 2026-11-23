import type { Page, TrackSummary } from '@squirmy/contracts';
import { useState } from 'react';
import { useSignedInApi, type Api } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { announce, useBriefFailures } from '../inlineFeedback';
import { playAllFailure } from './failures';
import { loadRest, maxPlayed } from './loadAll';
import { useStartGuard } from './pending';

/** A list loaded page by page as it scrolls, as `usePagedQuery` returns it. */
type PagedList<T> = { items: readonly T[]; hasNextPage: boolean; data?: { pages: readonly Page<T>[] } };

export type PlayAllSource<T> = {
  list: PagedList<T>;
  fetchPage: (api: Api, cursor: string, limit: number) => Promise<Page<T>>;
  tracksOf: (items: readonly T[]) => TrackSummary[];
  /** How many items to load; the whole list (up to the session's limit) by default. */
  limit?: (start: number) => number;
};

const key = 'all';

/**
 * Plays a list that may not be fully loaded yet: the rest is fetched first, so Play,
 * Shuffle and a tap on a row play the whole list and not just the rows scrolled past.
 * `busy` is true meanwhile; taps made then are ignored rather than starting it twice.
 * When the rest can't be loaded it plays what was, and `failed` says which button started it
 * for a few seconds, so the page can say so under it.
 */
export function usePlayAll<T>({ list, fetchPage, tracksOf, limit = () => maxPlayed }: PlayAllSource<T>) {
  const api = useSignedInApi();
  const store = useTrackStore();
  const starts = useStartGuard();
  const [mode, setMode] = useState<'play' | 'shuffle'>('play');
  const { failures, fail, drop } = useBriefFailures<'play' | 'shuffle'>();

  const run = (start: number | undefined, shuffle: boolean, play: (tracks: TrackSummary[]) => void) => {
    if (starts.pending(key)) return;
    const cursor = list.data?.pages.at(-1)?.nextCursor;
    if (!list.hasNextPage || !cursor || !api) return play(tracksOf(list.items));
    setMode(shuffle ? 'shuffle' : 'play');
    drop(key);
    starts.run(key, async () => {
      try {
        const items = await loadRest(list.items, cursor, (next, size) => fetchPage(api, next, size), limit(start ?? 0));
        const tracks = tracksOf(items);
        store.prime(tracks);
        play(tracks);
      } catch {
        fail(key, shuffle ? 'shuffle' : 'play');
        announce(playAllFailure);
        play(tracksOf(list.items));
      }
    });
  };
  return { busy: starts.pending(key) ? mode : null, failed: failures.get(key) ?? null, run };
}
