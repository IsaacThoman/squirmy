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
  /**
   * Names the stream in the app's streaming cache: a load, the preload and a prefetch with
   * the same key read one download, and its file is reported in `cacheComplete` once whole.
   * Without one, the engine deletes what it downloaded once done with it.
   */
  cacheKey: string | null;
  /** For `stream`; the file reader reads a file's own instead. */
  gapless: NativeGapless | null;
  /** `stream` for server transcodes, `file` for originals and downloads. */
  decoder: 'file' | 'stream';
  /** For a preload: it continues the loaded item's album in album order, so it is never crossfaded into. */
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
  /** How long the next item overlaps the loaded one's end, in seconds; 0 for none. Missing in builds before it. */
  setCrossfade?(seconds: number): void;
  /** A level from 0 to 1 over everything that plays (the sleep timer's fade). Missing in builds before it. */
  setFade?(level: number): void;
  /** Synchronous, with the position read from the clock now. */
  getStatus(): NativeStatus;
  /** A TestFlight build, which shows the engine setting as development builds do. */
  readonly isTestFlight?: boolean;
  /**
   * Downloads `url` under `cacheKey` without playing it, unless it is downloading already; an
   * item loaded with the same key reads the same download. Ends in `cacheComplete` or
   * `cacheDropped`.
   */
  prefetch(cacheKey: string, url: string): void;
  /** Stops a prefetch; its download goes on while an item reads it. */
  cancelPrefetch(cacheKey: string): void;
  addListener(event: 'status', listener: (status: NativeStatus) => void): EventSubscription;
  addListener(event: 'ended' | 'interrupted' | 'resumed', listener: (event: { entryId: string }) => void): EventSubscription;
  addListener(event: 'error', listener: (event: { entryId: string; message: string }) => void): EventSubscription;
  addListener(event: 'log', listener: (event: { message: string }) => void): EventSubscription;
  /** A keyed stream is whole in the file at `uri`, which is the app’s now: the engine neither moves nor deletes it. */
  addListener(event: 'cacheComplete', listener: (event: NativeCacheComplete) => void): EventSubscription;
  /** A keyed stream was given up before it was whole (skipped, cancelled or failed); there is no file. */
  addListener(event: 'cacheDropped', listener: (event: { cacheKey: string; message: string }) => void): EventSubscription;
};

export type NativeCacheComplete = { cacheKey: string; uri: string; bytes: number };

/** iOS and tvOS only; `null` elsewhere, and in an app built before it was added. */
export default requireOptionalNativeModule<SquirmyAudio>('SquirmyAudioEngine');
