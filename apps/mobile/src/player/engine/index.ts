import type { PlayerEngine } from '@squirmy/client-core';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Platform } from 'react-native';
import NativeAudio, { type NativeEqualizer } from '../../../modules/audio-engine';
import NowPlaying, { type AudioOutput } from '../../../modules/now-playing';
import { playbackRequestFor, type PlaybackRequest } from '../session';
import { ExpoAudioEngine, type ExpoAudioEngineOptions } from './ExpoAudioEngine';
import { NativeEngine } from './NativeEngine';
import { storedEngine, type PlaybackEngineKind } from './setting';

export { ExpoAudioEngine } from './ExpoAudioEngine';
export { NativeEngine } from './NativeEngine';
export { connectNowPlaying, type NowPlayingItem, type RemoteControls } from './nowPlaying';

/** What the app asks of either engine beyond the `PlayerEngine` contract. */
export type AppEngine = PlayerEngine & {
  /** Its gain can turn a song up (`SessionPlayer.canBoost`). */
  readonly canBoost: boolean;
  /** It limits true peaks after the gain (`SessionPlayer.limiter`). */
  readonly limiter: boolean;
  holdAudioSession(hold: boolean): void;
  isTryingToPlay(): boolean;
  dispose?(): void;
  /** The native engine's equalizer, where the build has it. */
  readonly equalizer?: boolean;
  setEqualizer?(curve: NativeEqualizer | null): void;
  /** The native engine's crossfade, where the build has it. */
  readonly crossfade?: boolean;
  setCrossfade?(seconds: number): void;
};

/** Native playback reports position this often, in milliseconds. */
const updateIntervalMs = 250;

// Two seconds of silence, looped while the engine waits for a track the server is fetching.
const silence = require('./silence.m4a') as number;

let audioMode: Promise<void> | undefined;

/**
 * Asks once for background playback in silent mode. A refusal (another app holding the
 * audio session at launch) is asked again with the next player, instead of leaving the
 * whole run without background audio.
 */
function ensureAudioMode(): void {
  audioMode ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
    allowsRecording: false,
  }).catch((error: unknown) => {
    audioMode = undefined;
    console.warn('Couldn’t set the audio mode; trying again with the next track.', error);
  });
}

let running: PlaybackEngineKind | undefined;

/**
 * The engine this run of the app plays with, decided once: the setting applies from the next
 * launch, and `native` only when this build has the native engine and it starts. The streaming
 * cache follows it too, since the native engine keeps what it streams.
 */
export function runningEngine(): PlaybackEngineKind {
  running ??= storedEngine() === 'native' && startNative() ? 'native' : 'classic';
  return running;
}

let request: PlaybackRequest | undefined;

/**
 * What `/tracks/:id/playback` asks for while this run's engine plays (`playbackRequestFor`),
 * decided once. A native module from before the fragmented profiles has no `probeCodecs` and
 * cannot read them, so it asks as the classic engine does.
 */
export function playbackRequest(): PlaybackRequest {
  const native = runningEngine() === 'native' ? NativeAudio : null;
  request ??= playbackRequestFor(Platform.OS, native?.probeCodecs ? () => native.probeCodecs!() : undefined);
  return request;
}

/**
 * The phone's `PlayerEngine`: `kind` is this device's setting. Either plays in the background
 * and in silent mode, and takes the audio session exclusively, which the lock screen needs to
 * show the app as Now Playing. The native engine falls back to the classic one when this build
 * doesn't have it (an old build, Android) or it fails to start.
 */
export function createPlayerEngine(options: Pick<ExpoAudioEngineOptions, 'onInterrupted' | 'onResumed'> = {}, kind: PlaybackEngineKind = 'classic'): AppEngine {
  const log = (message: string) => console.info(`[engine] ${message}`);
  if (kind === 'native') {
    const native = startNative();
    if (native) {
      log('playing with the native engine');
      return new NativeEngine({ native, ...options, log });
    }
  }
  return createClassicEngine(options, log);
}

/** The native module, or null with the reason logged. */
function startNative() {
  if (!NativeAudio) {
    console.info('[engine] this build has no native engine; playing with the classic one');
    return null;
  }
  try {
    NativeAudio.getStatus();
    return NativeAudio;
  } catch (error) {
    console.warn('[engine] the native engine didn’t start; playing with the classic one', error);
    return null;
  }
}

function createClassicEngine(options: Pick<ExpoAudioEngineOptions, 'onInterrupted' | 'onResumed'>, log: (message: string) => void) {
  ensureAudioMode();
  return new ExpoAudioEngine({
    ...options,
    log,
    describeOutput: currentOutput,
    holdRunning: hold => void NowPlaying?.holdBackgroundTime?.(hold).catch(() => undefined),
    // Never AirPlay's external playback mode, in which iOS hands a player's URL to the
    // receiver to fetch and play itself: it cannot fetch the silence's local file. Decoded
    // here, the sound still goes to AirPlay through the audio route.
    createSilence: () => createAudioPlayer(silence, { keepAudioSessionActive: true, allowsExternalPlayback: false }),
    // A player keeps the session active from its first play() until it is removed, so the
    // next entry can start without a gap. Before that first play() it keeps nothing; the
    // engine covers that time with silence.
    createPlayer: url => {
      ensureAudioMode();
      return createAudioPlayer({ uri: url }, { updateInterval: updateIntervalMs, keepAudioSessionActive: true, allowsExternalPlayback: false });
    },
  });
}

/**
 * Tells the classic engine what the audio session reports: interruptions (calls, Siri) and
 * the output going away; the native engine hears those itself. Logs route changes for either.
 * Returns a function that stops. Does nothing without the native module (Android, web).
 */
export function connectAudioSession(engine: AppEngine): () => void {
  const native = NowPlaying;
  if (!native) return () => undefined;
  const classic = engine instanceof ExpoAudioEngine ? engine : null;
  const interruptions = native.addListener('onInterruption', event => {
    if (!classic) return;
    if (event.type === 'began') classic.interrupt();
    else classic.endInterruption(event.shouldResume);
  });
  const routes = native.addListener('onRouteChange', ({ reason }) => {
    console.info(`[audio] route changed (${reason}): ${currentOutput() ?? 'unknown'}`);
    if (reason === 'oldDeviceUnavailable') classic?.routeLost();
  });
  return () => {
    interruptions.remove();
    routes.remove();
  };
}

/** Where the sound goes now, such as `AirPlay “Kitchen”`, for the log; null where it cannot be told. */
export function currentOutput(): string | null {
  const outputs = NowPlaying?.currentOutputs?.();
  return outputs ? describeOutputs(outputs) : null;
}

function describeOutputs(outputs: readonly AudioOutput[]): string {
  return outputs.length ? outputs.map(output => `${output.type} “${output.name}”`).join(', ') : 'no output';
}
