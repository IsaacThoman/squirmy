import type { EngineState } from '@squirmy/client-core';

/** How long after `play()` a player that has not started yet still counts as starting. */
export const startGraceMs = 1500;
/**
 * How long a player may say it is playing while its position stands still before that
 * counts as waiting for data. AVPlayer reports `playing` for a stream that has only begun to
 * arrive (a song the server has just fetched, or is still encoding), and its clock moves
 * only once sound comes out.
 */
export const stillClockMs = 1500;

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
};

/**
 * The engine state for a reading. A player that stopped although the engine wants it
 * playing, outside the start grace, counts as stalled: the system's own pauses (a call,
 * Siri, unplugged headphones) arrive as audio session events, so a stop seen here is the
 * stream running dry.
 */
export function engineState(reading: SlotReading): EngineState {
  if (reading.failed) return 'error';
  if (reading.finished) return 'ended';
  if (!reading.ready) return 'loading';
  if (!reading.wantsPlay) return 'paused';
  if (reading.playing) return 'playing';
  // Right after play() the player primes its buffers for a moment; that is not a stall.
  if (reading.sincePlay < startGraceMs) return reading.started ? 'playing' : 'loading';
  return reading.started ? 'buffering' : 'loading';
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
