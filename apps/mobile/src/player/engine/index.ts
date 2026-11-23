import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import NowPlaying, { type AudioOutput } from '../../../modules/now-playing';
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
    holdRunning: hold => void NowPlaying?.holdBackgroundTime?.(hold).catch(() => undefined),
    // Never AirPlay's external playback mode, in which iOS hands a player's URL to the receiver
    // to fetch and play itself: a receiver cannot fetch the silence's local file, and with it
    // and the song both handed over, the song waited forever (the spinner over AirPlay until
    // AirPlay was turned off). Decoded here, the sound still goes to AirPlay through the audio route.
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
  const routes = native.addListener('onRouteChange', ({ reason, outputs }) => {
    if (outputs) console.info(`[audio] route changed (${reason}): ${describeOutputs(outputs)}`);
    if (reason === 'oldDeviceUnavailable') engine.routeLost();
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

/** The kind of output only, such as `AirPlay`, for what goes to the server. */
export function currentOutputType(): string | undefined {
  return NowPlaying?.currentOutputs?.()[0]?.type;
}

function describeOutputs(outputs: readonly AudioOutput[]): string {
  return outputs.length ? outputs.map(output => `${output.type} “${output.name}”`).join(', ') : 'no output';
}
