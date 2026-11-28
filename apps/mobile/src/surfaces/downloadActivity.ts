/**
 * The downloads Live Activity: what to show for the collections downloading now, in the
 * Downloads screen's words. Plain logic, so it is tested without React Native.
 */
import type { DownloadActivityState } from '../../modules/app-intents';
import { downloadStatus, type CollectionDownload } from '../downloads/model';

/** A song or two (a heart on a downloaded Liked Songs) is not worth a Live Activity. */
export const activityMinimumSongs = 3;

export type DownloadActivity = { state: DownloadActivityState; ids: readonly string[] } | null;

export type DownloadingCollection = { id: string; title: string; download: CollectionDownload | undefined };

/**
 * The activity after `previous`, given every downloaded collection. It starts when enough songs
 * are downloading, follows those collections until none is downloading, then says how it
 * ended; one that only waits (for Wi-Fi) ends without saying it is done.
 */
export function nextDownloadActivity(last: DownloadActivity, collections: readonly DownloadingCollection[]): DownloadActivity {
  // A finished one has been said; downloads after it start a new activity.
  const previous = last?.state.finished ? null : last;
  const downloading = collections.filter(collection => collection.download?.state === 'downloading');
  const tracked = previous
    ? collections.filter(collection => previous.ids.includes(collection.id) || downloading.includes(collection))
    : downloading;
  // Removed while it downloaded: nothing to say.
  if (!tracked.length) return null;

  const done = sum(tracked, download => download.done);
  const total = sum(tracked, download => download.total);
  if (tracked.some(collection => collection.download?.state === 'downloading')) {
    const remaining = sum(tracked, download => download.total - download.done - download.unavailable);
    if (!previous && remaining < activityMinimumSongs) return null;
    const single = tracked.length === 1 ? tracked[0]! : null;
    return {
      ids: tracked.map(collection => collection.id),
      state: {
        title: single ? single.title : `${tracked.length} downloads`,
        detail: single?.download ? downloadStatus(single.download).text : `Downloading ${Math.min(done + 1, total)} of ${total}`,
        done, total, finished: false,
      },
    };
  }
  if (!previous) return null;
  const settled = tracked.every(collection => ['done', 'incomplete', 'failed'].includes(collection.download?.state ?? ''));
  return settled ? finish({ ...previous, state: { ...previous.state, done, total } }) : null;
}

function finish(previous: NonNullable<DownloadActivity>): DownloadActivity {
  const { done, total } = previous.state;
  return { ids: previous.ids, state: { ...previous.state, detail: done >= total ? 'Downloaded' : `${done} of ${total} downloaded`, finished: true } };
}

function sum(collections: readonly DownloadingCollection[], count: (download: CollectionDownload) => number): number {
  return collections.reduce((total, collection) => total + (collection.download ? count(collection.download) : 0), 0);
}
