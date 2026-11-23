import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import NowPlaying from '../../../modules/now-playing';
import { ExpoAudioEngine, type ExpoAudioEngineOptions } from './ExpoAudioEngine';

export { ExpoAudioEngine } from './ExpoAudioEngine';
export { connectNowPlaying, type NowPlayingItem, type RemoteControls } from './nowPlaying';

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

/**
 * The phone's `PlayerEngine`. Plays in the background and in silent mode, and takes the
 * audio session exclusively, which the lock screen needs to show the app as Now Playing.
 */
export function createPlayerEngine(options: Pick<ExpoAudioEngineOptions, 'onInterrupted' | 'onResumed'> = {}) {
  ensureAudioMode();
  return new ExpoAudioEngine({
    ...options,
    log: message => console.info(`[engine] ${message}`),
    createSilence: () => createAudioPlayer(silence, { keepAudioSessionActive: true }),
    // A player keeps the session active from its first play() until it is removed, so the
    // next entry can start without a gap. Before that first play() it keeps nothing; the
    // engine covers that time with silence.
    createPlayer: url => {
      ensureAudioMode();
      return createAudioPlayer({ uri: url }, { updateInterval: updateIntervalMs, keepAudioSessionActive: true });
    },
  });
}

/**
 * Tells `engine` what the audio session reports: interruptions (calls, Siri) and the
 * output going away. Returns a function that stops. Does nothing without the native
 * module (Android, web).
 */
export function connectAudioSession(engine: ExpoAudioEngine): () => void {
  const native = NowPlaying;
  if (!native) return () => undefined;
  const interruptions = native.addListener('onInterruption', event => {
    if (event.type === 'began') engine.interrupt();
    else engine.endInterruption(event.shouldResume);
  });
  const routes = native.addListener('onRouteChange', ({ reason }) => {
    if (reason === 'oldDeviceUnavailable') engine.routeLost();
  });
  return () => {
    interruptions.remove();
    routes.remove();
  };
}
