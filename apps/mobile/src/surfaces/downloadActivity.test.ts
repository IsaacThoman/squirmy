import { describe, expect, it } from 'vitest';
import type { CollectionDownload } from '../downloads/model';
import { nextDownloadActivity, type DownloadingCollection } from './downloadActivity';

const download = (state: CollectionDownload['state'], done: number, total: number, unavailable = 0): CollectionDownload =>
  ({ state, done, total, failed: 0, unavailable, wait: null, retryable: false, gone: false, bytes: 0 }) as CollectionDownload;
const collection = (id: string, title: string, value: CollectionDownload): DownloadingCollection => ({ id, title, download: value });

describe('the downloads Live Activity', () => {
  it('starts for an album downloading, in the Downloads screen’s words', () => {
    const next = nextDownloadActivity(null, [collection('album:a1', 'Harbor', download('downloading', 2, 12))]);
    expect(next).toEqual({ ids: ['album:a1'], state: { title: 'Harbor', detail: 'Downloading 3 of 12', done: 2, total: 12, finished: false } });
  });

  it('does not start for a song or two, as a new heart on a downloaded Liked Songs is', () => {
    expect(nextDownloadActivity(null, [collection('liked', 'Liked Songs', download('downloading', 120, 122))])).toBeNull();
    expect(nextDownloadActivity(null, [collection('album:a1', 'Harbor', download('done', 12, 12))])).toBeNull();
  });

  it('counts every collection downloading together', () => {
    const next = nextDownloadActivity(null, [
      collection('album:a1', 'Harbor', download('downloading', 2, 12)),
      collection('playlist:p1', 'Night Drive', download('downloading', 0, 8)),
      collection('album:old', 'Old', download('done', 9, 9)),
    ]);
    expect(next?.state).toEqual({ title: '2 downloads', detail: 'Downloading 3 of 20', done: 2, total: 20, finished: false });
  });

  it('says how it ended once nothing is downloading, then starts afresh', () => {
    let activity = nextDownloadActivity(null, [collection('album:a1', 'Harbor', download('downloading', 2, 12))]);
    activity = nextDownloadActivity(activity, [collection('album:a1', 'Harbor', download('downloading', 11, 12))]);
    expect(activity?.state).toMatchObject({ detail: 'Downloading 12 of 12', finished: false });
    activity = nextDownloadActivity(activity, [collection('album:a1', 'Harbor', download('done', 12, 12))]);
    expect(activity?.state).toEqual({ title: 'Harbor', detail: 'Downloaded', done: 12, total: 12, finished: true });
    const short = nextDownloadActivity(nextDownloadActivity(null, [collection('album:a1', 'Harbor', download('downloading', 3, 12))]),
      [collection('album:a1', 'Harbor', download('incomplete', 11, 12, 1))]);
    expect(short?.state).toMatchObject({ detail: '11 of 12 downloaded', finished: true });

    const again = nextDownloadActivity(activity, [
      collection('album:a1', 'Harbor', download('done', 12, 12)),
      collection('album:a2', 'Tidewater', download('downloading', 0, 9)),
    ]);
    expect(again).toEqual({ ids: ['album:a2'], state: { title: 'Tidewater', detail: 'Downloading 1 of 9', done: 0, total: 9, finished: false } });
  });

  it('ends without saying it is done when the downloads wait for Wi-Fi, or were removed', () => {
    const started = nextDownloadActivity(null, [collection('album:a1', 'Harbor', download('downloading', 2, 12))]);
    expect(nextDownloadActivity(started, [collection('album:a1', 'Harbor', download('queued', 2, 12))])).toBeNull();
    expect(nextDownloadActivity(started, [])).toBeNull();
  });
});
