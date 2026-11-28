import { useSyncExternalStore } from 'react';
import { accountItem } from '../../data/accountStorage';
import { equalizerCurve, readEqualizer, type EqualizerSetting } from './equalizer';
import type { AppEngine } from './index';

/**
 * What this device does to the sound on its way out (the equalizer), kept on the device: it
 * belongs to the headphones or speakers, not to the account. Read from storage on first use,
 * and handed to the engine as it changes.
 */

const equalizerItem = accountItem<EqualizerSetting>('equalizer', 'device');
const listeners = new Set<() => void>();
let equalizer: EqualizerSetting | undefined;

export function storedEqualizer(): EqualizerSetting {
  equalizer ??= readEqualizer(equalizerItem.read());
  return equalizer;
}

/** Saves the equalizer and applies it at once. Written off the JS thread, as a slider moves it often. */
export function setStoredEqualizer(next: EqualizerSetting): void {
  equalizer = next;
  equalizerItem.writeAsync(next);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Settings' equalizer: what is stored, and a change, which plays at once. */
export function useEqualizerSetting(): [EqualizerSetting, (next: EqualizerSetting) => void] {
  return [useSyncExternalStore(subscribe, storedEqualizer), setStoredEqualizer];
}

/**
 * Hands `engine` the device's equalizer now and whenever it changes, for an engine that has
 * one. Returns a function that stops.
 */
export function followOutputSettings(engine: AppEngine): () => void {
  if (!engine.equalizer || !engine.setEqualizer) return () => undefined;
  const setEqualizer = engine.setEqualizer.bind(engine);
  let applied: string | undefined;
  const apply = () => {
    const curve = equalizerCurve(storedEqualizer());
    const key = JSON.stringify(curve);
    if (key === applied) return;
    applied = key;
    setEqualizer(curve);
  };
  apply();
  return subscribe(apply);
}
