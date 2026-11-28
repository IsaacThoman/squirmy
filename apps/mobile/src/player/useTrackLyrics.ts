import type { TrackSummary } from '@squirmy/contracts';
import { useSyncExternalStore } from 'react';
import { useLyrics } from '../data/queries';
import { useRealtime } from '../data/realtime';
import { useDownloadManager } from '../downloads/DownloadsProvider';

const noSubscription = () => () => undefined;

/**
 * The lyrics of `track` for the Lyrics page, with those kept with its download standing in
 * offline (`useLyrics`). The TV keeps no downloads, so there it is the server's alone.
 */
export function useTrackLyrics(track: TrackSummary | undefined) {
  const manager = useDownloadManager();
  const { offline } = useRealtime();
  const id = track?.id;
  const lyrics = useSyncExternalStore(manager?.subscribe ?? noSubscription, () => (id ? manager?.lyrics(id) : undefined));
  return useLyrics(track, manager && id ? { lyrics, offline, keep: answer => manager.keepLyrics(id, answer) } : undefined);
}
