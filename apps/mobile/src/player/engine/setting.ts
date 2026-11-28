import { useState } from 'react';
import NativeAudio from '../../../modules/audio-engine';
import { accountItem } from '../../data/accountStorage';

/** `classic` is `ExpoAudioEngine`; `native` is the engine in `modules/audio-engine`. */
export type PlaybackEngineKind = 'classic' | 'native';

/** Kept on this device only: the engine belongs to the build and the device, not the account. */
const engineItem = accountItem<PlaybackEngineKind>('playbackEngine', 'device');

/** The engine this device plays with, `classic` unless the native one was chosen. */
export function storedEngine(): PlaybackEngineKind {
  return engineItem.read() === 'native' ? 'native' : 'classic';
}

export const engineOptions: readonly { value: PlaybackEngineKind; label: string }[] = [
  { value: 'classic', label: 'Classic' },
  { value: 'native', label: 'Native' },
];

export const engineNote = 'Native is Squirmy’s own audio engine, which plays one song into the next without a gap. It’s still being tested, so only development and TestFlight builds offer it. A change applies the next time Squirmy opens.';

/** Development and TestFlight builds that have the native engine offer the choice. */
export function showsEngineSetting(): boolean {
  return NativeAudio !== null && (__DEV__ || NativeAudio.isTestFlight === true);
}

/** Settings' engine choice: what is stored, which takes effect at the next launch. */
export function useEngineSetting(): [PlaybackEngineKind, (kind: PlaybackEngineKind) => void] {
  const [kind, setKind] = useState(storedEngine);
  return [kind, next => {
    engineItem.write(next);
    setKind(next);
  }];
}
