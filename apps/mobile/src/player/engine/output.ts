import { useSyncExternalStore } from 'react';
import { accountItem } from '../../data/accountStorage';
import { readCrossfade } from './crossfade';
import { equalizerCurve, readEqualizer, type EqualizerSetting } from './equalizer';
import type { AppEngine } from './index';

/**
 * What this device does to the sound on its way out (the equalizer and crossfade), kept on
 * the device: it belongs to the headphones or speakers and to how this device is listened to,
 * not to the account. Read from storage on first use, and handed to the engine as it changes.
 */

const equalizerItem = accountItem<EqualizerSetting>('equalizer', 'device');
const crossfadeItem = accountItem<number>('crossfade', 'device');
const listeners = new Set<() => void>();
let equalizer: EqualizerSetting | undefined;
let crossfade: number | undefined;

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

/** The crossfade's length in seconds; 0 is off. */
export function storedCrossfade(): number {
  crossfade ??= readCrossfade(crossfadeItem.read());
  return crossfade;
}

export function setStoredCrossfade(seconds: number): void {
  crossfade = readCrossfade(seconds);
  crossfadeItem.write(crossfade);
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

/** Settings' crossfade: its length in seconds (0 is off), and a change, for the next song on. */
export function useCrossfadeSetting(): [number, (seconds: number) => void] {
  return [useSyncExternalStore(subscribe, storedCrossfade), setStoredCrossfade];
}

/**
 * Hands `engine` the device's equalizer and crossfade now and whenever they change, for an
 * engine that has them. Returns a function that stops.
 */
export function followOutputSettings(engine: AppEngine): () => void {
  const setEqualizer = engine.equalizer ? engine.setEqualizer?.bind(engine) : undefined;
  const setCrossfade = engine.crossfade ? engine.setCrossfade?.bind(engine) : undefined;
  if (!setEqualizer && !setCrossfade) return () => undefined;
  let applied: { curve: string; crossfade: number } | undefined;
  const apply = () => {
    const curve = equalizerCurve(storedEqualizer());
    const key = JSON.stringify(curve);
    const seconds = storedCrossfade();
    if (key !== applied?.curve) setEqualizer?.(curve);
    if (seconds !== applied?.crossfade) setCrossfade?.(seconds);
    applied = { curve: key, crossfade: seconds };
  };
  apply();
  return subscribe(apply);
}
