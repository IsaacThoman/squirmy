import { requireOptionalNativeModule, type EventSubscription } from 'expo';
import type { EngineState } from '@squirmy/client-core';

/** The exact numbers of a delivered stream, from the playback descriptor. */
export type NativeGapless = { sampleRate: number; primingFrames: number; frames: number };

export type NativeItem = {
  entryId: string;
  /** Absolute and signed, or a `file://` URL for a download. */
  url: string;
  startMs: number;
  /** Linear; may exceed 1. */
  gain: number;
  cacheKey: string | null;
  /** For `stream`; the file reader reads a file's own instead. */
  gapless: NativeGapless | null;
  /** `stream` for server transcodes, `file` for originals and downloads. */
  decoder: 'file' | 'stream';
  /** The next item continues this one's album: never crossfaded into. */
  albumRun: boolean;
};

/** The equalizer's curve: a gain for each band from 31 Hz to 16 kHz, and the preamp, in dB. */
export type NativeEqualizer = { bandsDb: number[]; preampDb: number };

export type NativeStatus = {
  entryId: string | null;
  state: EngineState;
  positionMs: number;
  /** Asked to play and not paused since, which includes loading and buffering to play. */
  playing: boolean;
};

export type SquirmyAudio = {
  load(item: NativeItem & { autoplay: boolean }): void;
  preload(item: NativeItem | null): void;
  play(): void;
  pause(): void;
  seek(positionMs: number): void;
  setGain(gain: number): void;
  stop(): void;
  /** While true and nothing is loaded, plays silence so iOS keeps the app running. */
  holdAudioSession(hold: boolean): void;
  /** The equalizer's curve, or null for none; heard after the lead. Missing in builds before it. */
  setEqualizer?(curve: NativeEqualizer | null): void;
  /** Synchronous, with the position read from the clock now. */
  getStatus(): NativeStatus;
  /** A TestFlight build, which shows the engine setting as development builds do. */
  readonly isTestFlight?: boolean;
  addListener(event: 'status', listener: (status: NativeStatus) => void): EventSubscription;
  addListener(event: 'ended' | 'interrupted' | 'resumed', listener: (event: { entryId: string }) => void): EventSubscription;
  addListener(event: 'error', listener: (event: { entryId: string; message: string }) => void): EventSubscription;
  addListener(event: 'log', listener: (event: { message: string }) => void): EventSubscription;
};

/** iOS and tvOS only; `null` elsewhere, and in an app built before it was added. */
export default requireOptionalNativeModule<SquirmyAudio>('SquirmyAudioEngine');
