import type { PlaybackNotice } from '@squirmy/client-core';

/** How long a one-off status (a skipped song, one that couldn't play) stays in the player. */
export const eventShownMs = 5000;

/** A line the player shows in place of the artist: client-core's notice wording, `detail` a quieter second line. */
export type PlaybackStatus = PlaybackNotice & { id: number; lasting: boolean };

/** What VoiceOver hears for a status: both lines. */
export function spokenStatus({ message, detail }: PlaybackNotice): string {
  return detail ? `${message}. ${detail}` : message;
}

/**
 * What the player says about playback, in the mini player and Now Playing, where the
 * artist line would be. The app has no toasts.
 *
 * A one-off event (a skip, a song that couldn't play, rejoining the other devices) shows
 * for `eventShownMs`. A lasting one explains a pause (the server can't fetch music, nothing
 * left plays offline) and stays until playback resumes (`resume`). The newest shows: a
 * one-off reported during a lasting status shows over it for its few seconds, then the
 * lasting one shows again; a lasting status replaces whatever was there.
 */
export class PlaybackStatusStore {
  private event: PlaybackStatus | null = null;
  private lasting: PlaybackStatus | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly announce: (text: string) => void = () => undefined) {}

  report(notice: PlaybackNotice, { lasting = false }: { lasting?: boolean } = {}): void {
    const status: PlaybackStatus = { message: notice.message, ...notice.detail && { detail: notice.detail }, id: this.nextId++, lasting };
    if (lasting) {
      this.lasting = status;
      this.dropEvent();
    } else {
      clearTimeout(this.timer);
      this.event = status;
      this.timer = setTimeout(() => {
        this.event = null;
        this.emit();
      }, eventShownMs);
    }
    this.announce(spokenStatus(notice));
    this.emit();
  }

  /** Playback started again: the pause a lasting status explained is over. */
  resume(): void {
    if (!this.lasting) return;
    this.lasting = null;
    this.emit();
  }

  /** Forgets everything, as signing out does. */
  clear(): void {
    if (!this.event && !this.lasting) return;
    this.lasting = null;
    this.dropEvent();
    this.emit();
  }

  /** What the player shows now, if anything. The same object until it changes. */
  readonly current = (): PlaybackStatus | null => this.event ?? this.lasting;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dropEvent() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.event = null;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
