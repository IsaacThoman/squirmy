import type { EngineState } from '@squirmy/client-core';

/** How long after `play()` a player that has not started yet still counts as starting. */
export const startGraceMs = 1500;

/** What the engine knows about the loaded entry, and what its player reports now. */
export type SlotReading = {
  failed: boolean;
  finished: boolean;
  /** Loaded, and the start position (if any) has been sought to. */
  ready: boolean;
  /** The engine was asked to play (and nothing paused it since). */
  wantsPlay: boolean;
  /** It has played audio since it was loaded. */
  started: boolean;
  /** Milliseconds since the engine last called the player's `play()`. */
  sincePlay: number;
  playing: boolean;
  /** The player is waiting for data (`waitingToPlayAtSpecifiedRate` on iOS). */
  waiting: boolean;
};

/**
 * The engine state for a reading. `interrupted` means the player stopped although the
 * engine wants it playing and it is not waiting for data: the system paused it (a call,
 * Siri, unplugged headphones). The engine reports that as `paused` and never resumes.
 */
export function engineState(reading: SlotReading): { state: EngineState; interrupted: boolean } {
  const settled = (state: EngineState) => ({ state, interrupted: false });
  if (reading.failed) return settled('error');
  if (reading.finished) return settled('ended');
  if (!reading.ready) return settled('loading');
  if (!reading.wantsPlay) return settled('paused');
  if (reading.playing) return settled('playing');
  // Right after play() the player primes its buffers for a moment; that is not a stall.
  if (reading.sincePlay < startGraceMs) return settled(reading.started ? 'playing' : 'loading');
  if (reading.waiting) return settled(reading.started ? 'buffering' : 'loading');
  return { state: 'paused', interrupted: true };
}

/**
 * A short explanation of a native playback failure. AVFoundation gives either a localized
 * description ("Could not connect to the server.") or, for some failures, a generic one
 * carrying the code ("The operation couldn’t be completed. (NSURLErrorDomain error -1004.)").
 */
export function playbackErrorMessage(native: string): string {
  const code = /NSURLErrorDomain error (-\d+)/.exec(native)?.[1];
  const is = (codes: string[], text: RegExp) => (code !== undefined && codes.includes(code)) || text.test(native);
  if (is(['-1001'], /timed out/i)) return 'The server took too long to send this track.';
  if (is(['-1003', '-1004', '-1005', '-1009'], /could not connect|cannot connect|connection was lost|offline|hostname could not be found/i)) {
    return 'Couldn’t reach the server to play this track.';
  }
  if (is(['-1100', '-1011'], /not found|\b(403|404|410)\b/i)) return 'The server couldn’t find this track.';
  if (is(['-1200', '-1202'], /certificate|secure connection/i)) return 'The server’s certificate isn’t trusted.';
  if (/cannot open|format|unsupported|decode/i.test(native)) return 'This track’s file can’t be played.';
  return native || 'This track couldn’t be played.';
}
