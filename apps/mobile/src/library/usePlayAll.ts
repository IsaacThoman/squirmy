import type { Page, TrackSummary } from '@squirmy/contracts';
import { useRef, useState } from 'react';
import { useSignedInApi, type Api } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { useNotice } from '../Notice';
import { loadRest, maxPlayed } from './loadAll';

/** A list loaded page by page as it scrolls, as `usePagedQuery` returns it. */
type PagedList<T> = { items: readonly T[]; hasNextPage: boolean; data?: { pages: readonly Page<T>[] } };

export type PlayAllSource<T> = {
  list: PagedList<T>;
  fetchPage: (api: Api, cursor: string, limit: number) => Promise<Page<T>>;
  tracksOf: (items: readonly T[]) => TrackSummary[];
  /** How many items to load; the whole list (up to the session's limit) by default. */
  limit?: (start: number) => number;
};

/**
 * Plays a list that may not be fully loaded yet: the rest is fetched first, so Play,
 * Shuffle and a tap on a row play the whole list and not just the rows scrolled past.
 * `busy` is true meanwhile; taps made then are ignored rather than starting it twice.
 */
export function usePlayAll<T>({ list, fetchPage, tracksOf, limit = () => maxPlayed }: PlayAllSource<T>) {
  const api = useSignedInApi();
  const store = useTrackStore();
  const notify = useNotice();
  const [busy, setBusy] = useState<'play' | 'shuffle' | null>(null);
  const running = useRef(false);

  const run = async (start: number | undefined, shuffle: boolean, play: (tracks: TrackSummary[]) => void) => {
    if (running.current) return;
    const cursor = list.data?.pages.at(-1)?.nextCursor;
    if (!list.hasNextPage || !cursor || !api) return play(tracksOf(list.items));
    running.current = true;
    setBusy(shuffle ? 'shuffle' : 'play');
    try {
      const items = await loadRest(list.items, cursor, (next, size) => fetchPage(api, next, size), limit(start ?? 0));
      const tracks = tracksOf(items);
      store.prime(tracks);
      play(tracks);
    } catch {
      notify('Couldn’t load the whole list. Playing the songs loaded so far.');
      play(tracksOf(list.items));
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return { busy, run };
}
