import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import NowPlaying from '../../../modules/now-playing';
import { ExpoAudioEngine, type ExpoAudioEngineOptions } from './ExpoAudioEngine';

export { ExpoAudioEngine } from './ExpoAudioEngine';
export { connectNowPlaying, type NowPlayingItem, type RemoteControls } from './nowPlaying';

/** Native playback reports position this often, in milliseconds. */
const updateIntervalMs = 250;

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
    // Keeping the session active between entries lets the next one start without a gap.
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
