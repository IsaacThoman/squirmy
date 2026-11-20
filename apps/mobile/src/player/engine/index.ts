import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { ExpoAudioEngine, type ExpoAudioEngineOptions } from './ExpoAudioEngine';

export { ExpoAudioEngine } from './ExpoAudioEngine';
export { connectNowPlaying, type NowPlayingItem, type RemoteControls } from './nowPlaying';

/** Native playback reports position this often, in milliseconds. */
const updateIntervalMs = 250;

let audioMode: Promise<void> | undefined;

/**
 * The phone's `PlayerEngine`. Plays in the background and in silent mode, and takes the
 * audio session exclusively, which the lock screen needs to show the app as Now Playing.
 */
export function createPlayerEngine(options: Pick<ExpoAudioEngineOptions, 'onInterrupted'> = {}) {
  audioMode ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
    allowsRecording: false,
  });
  return new ExpoAudioEngine({
    ...options,
    // Keeping the session active between entries lets the next one start without a gap.
    createPlayer: url => createAudioPlayer({ uri: url }, { updateInterval: updateIntervalMs, keepAudioSessionActive: true }),
  });
}
