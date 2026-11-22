import type { Page, TrackSummary } from '@squirmy/contracts';
import { useState } from 'react';
import { useSignedInApi, type Api } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { useNotice } from '../Notice';
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
 */
export function usePlayAll<T>({ list, fetchPage, tracksOf, limit = () => maxPlayed }: PlayAllSource<T>) {
  const api = useSignedInApi();
  const store = useTrackStore();
  const notify = useNotice();
  const starts = useStartGuard();
  const [mode, setMode] = useState<'play' | 'shuffle'>('play');

  const run = (start: number | undefined, shuffle: boolean, play: (tracks: TrackSummary[]) => void) => {
    if (starts.pending(key)) return;
    const cursor = list.data?.pages.at(-1)?.nextCursor;
    if (!list.hasNextPage || !cursor || !api) return play(tracksOf(list.items));
    setMode(shuffle ? 'shuffle' : 'play');
    starts.run(key, async () => {
      try {
        const items = await loadRest(list.items, cursor, (next, size) => fetchPage(api, next, size), limit(start ?? 0));
        const tracks = tracksOf(items);
        store.prime(tracks);
        play(tracks);
      } catch {
        notify('Couldn’t load the whole list. Playing the songs loaded so far.');
        play(tracksOf(list.items));
      }
    });
  };
  return { busy: starts.pending(key) ? mode : null, run };
}
