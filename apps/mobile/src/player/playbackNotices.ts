import {
  PlaybackNoticeWatcher, skipNotice, unavailableNotice, type PlaybackNotice, type SessionClientSnapshot,
} from '@squirmy/client-core';
import type { EntryFailure } from '@squirmy/contracts';

type Watched = Pick<SessionClientSnapshot, 'session' | 'queue' | 'connection' | 'outage'>;

/** The parts of `PlaybackStatusStore` the reporter drives. */
export type NoticeStatus = {
  report: (notice: PlaybackNotice, options?: { lasting?: boolean }) => void;
  resume: () => void;
};

/**
 * What to say when the server could not fetch songs, worded and timed as on the web
 * (client-core's `PlaybackNoticeWatcher`): one status per song that was playing or next,
 * one counting a run of songs the provider does not have, and one when playback stops on a
 * failure instead, with no more per song until playback resumes.
 *
 * A song playback stayed on, paused (the listener picked it, or the queue ended on it), is
 * told as one that couldn't play, and that stays, as a stop does, until playback resumes or
 * moves to another song: nothing else explains the pause. Call the result with each snapshot.
 */
export function createNoticeReporter({ failureOf, titleOf, status }: {
  failureOf: (trackId: string) => EntryFailure | undefined;
  titleOf: (trackId: string, albumId: string | null) => string | undefined;
  status: NoticeStatus;
}) {
  const watcher = new PlaybackNoticeWatcher(failureOf);
  /** The current entry a lasting notice was told on, while it shows. */
  let stoppedOn: string | null | undefined;
  return (snapshot: Watched) => {
    const current = snapshot.session.current?.id ?? null;
    // A pause the player was explaining is over.
    if (snapshot.session.playing) {
      stoppedOn = undefined;
      status.resume();
    } else if (stoppedOn !== undefined && current !== stoppedOn) {
      stoppedOn = undefined;
      status.resume();
    }
    const stop = (notice: PlaybackNotice) => {
      stoppedOn = current;
      status.report(notice, { lasting: true });
    };
    const { skipped, unavailable, stopped } = watcher.update(snapshot);
    for (const { entry, failure, held } of skipped) {
      const notice = skipNotice(titleOf(entry.trackId, entry.albumId), failure, held);
      if (held) stop(notice);
      else status.report(notice);
    }
    // The player shows one status at a time, so a run's growing count replaces the last.
    if (unavailable) status.report(unavailableNotice(unavailable, titleOf(unavailable.entry.trackId, unavailable.entry.albumId)));
    if (stopped) stop(stopped);
  };
}
