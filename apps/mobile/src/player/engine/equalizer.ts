import type { NativeEqualizer } from '../../../modules/audio-engine';

/**
 * The native engine's equalizer as Settings shows it: presets and a custom curve over ten
 * bands, an octave apart. The engine itself makes each band's gain land at its centre
 * (`modules/audio-engine/core/Sources/SquirmyAudioCore/Equalizer.swift`).
 */

/** The bands, 31 Hz to 16 kHz, as the editor shows them and as VoiceOver says them. */
export const equalizerBands: readonly { label: string; spoken: string }[] = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(hertz => hertz < 1000
  ? { label: `${hertz} Hz`, spoken: `${hertz} hertz` }
  : { label: `${hertz / 1000} kHz`, spoken: `${hertz / 1000} kilohertz` });

/** How far a band turns up or down, in dB. */
export const equalizerRangeDb = 12;

/** How far the preamp turns everything up: a little, for curves that mostly cut. */
export const maxPreampDb = 6;

export type EqualizerPreset = 'off' | 'bassBoost' | 'bassReducer' | 'trebleBoost' | 'vocal' | 'lateNight' | 'custom';

/**
 * The device's equalizer: what is chosen, and the custom curve, kept when a preset is chosen
 * so that going back to Custom finds it. A null preamp is automatic.
 */
export type EqualizerSetting = {
  preset: EqualizerPreset;
  custom: { bandsDb: number[]; preampDb: number | null };
};

const flat = (): number[] => equalizerBands.map(() => 0);

/** Each preset's curve. The engine's tests measure these same curves. */
const presetCurves: Record<Exclude<EqualizerPreset, 'off' | 'custom'>, readonly number[]> = {
  bassBoost: [6, 5.5, 4.5, 3, 1.5, 0, 0, 0, 0, 0],
  bassReducer: [-6, -5.5, -4.5, -3, -1.5, 0, 0, 0, 0, 0],
  trebleBoost: [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 6],
  vocal: [-2, -2, -1, 0, 1.5, 3, 3.5, 2.5, 1, 0],
  // Fuller bass and treble, which the ear hears less of at a low volume.
  lateNight: [5, 4, 2.5, 1, 0, 0, 0, 1, 2.5, 4],
};

const presetLabels: Record<EqualizerPreset, string> = {
  off: 'Off',
  bassBoost: 'Bass Boost',
  bassReducer: 'Bass Reducer',
  trebleBoost: 'Treble Boost',
  vocal: 'Vocal',
  lateNight: 'Late Night',
  custom: 'Custom',
};

const presetOrder: readonly EqualizerPreset[] = ['off', 'bassBoost', 'bassReducer', 'trebleBoost', 'vocal', 'lateNight', 'custom'];

/** The phone's choices, Custom last. */
export const equalizerOptions: readonly { value: EqualizerPreset; label: string }[] = presetOrder.map(value => ({ value, label: presetLabels[value] }));

/** Apple TV's, which has no band editor: the presets alone. */
export const tvEqualizerOptions = equalizerOptions.filter(option => option.value !== 'custom');

export const defaultEqualizer: EqualizerSetting = { preset: 'off', custom: { bandsDb: flat(), preampDb: null } };

export const equalizerNote = 'The equalizer belongs to this device, so you can set it for the headphones or speakers you use. Late Night fills out the bass and treble, which are harder to hear at a low volume.';

export const customEqualizerNote = 'Each slider turns its band up or down by as much as 12 dB. The preamp turns everything down by the largest boost unless you set it, so a boost doesn’t distort.';

/** The preamp that keeps a curve's largest boost from going over: minus that boost, or 0. */
export function automaticPreamp(bandsDb: readonly number[]): number {
  const boost = Math.max(0, ...bandsDb);
  return boost === 0 ? 0 : -boost;
}

/** The curve to hand the engine, or null when the equalizer is off (or flat, which is the same). */
export function equalizerCurve(setting: EqualizerSetting): NativeEqualizer | null {
  if (setting.preset === 'off') return null;
  const bandsDb = setting.preset === 'custom' ? setting.custom.bandsDb : [...presetCurves[setting.preset]];
  const preampDb = setting.preset === 'custom' && setting.custom.preampDb !== null ? setting.custom.preampDb : automaticPreamp(bandsDb);
  if (preampDb === 0 && bandsDb.every(gain => gain === 0)) return null;
  return { bandsDb, preampDb };
}

/** A gain as the editor shows it: `+3.5 dB`, `0 dB`, `−6 dB`. */
export function formatGain(gainDb: number): string {
  const rounded = Math.round(gainDb * 2) / 2;
  if (rounded === 0) return '0 dB';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(rounded % 1 ? 1 : 0)} dB`;
}

/** What was stored, or the default for anything unreadable (an older or damaged value). */
export function readEqualizer(stored: unknown): EqualizerSetting {
  if (!stored || typeof stored !== 'object') return defaultEqualizer;
  const { preset, custom } = stored as Partial<EqualizerSetting>;
  const bands = custom && Array.isArray(custom.bandsDb) && custom.bandsDb.length === equalizerBands.length
    && custom.bandsDb.every(gain => typeof gain === 'number' && Number.isFinite(gain))
    ? custom.bandsDb.map(clampGain)
    : flat();
  const preamp = custom && typeof custom.preampDb === 'number' && Number.isFinite(custom.preampDb) ? clampGain(custom.preampDb) : null;
  return { preset: presetOrder.includes(preset as EqualizerPreset) ? preset as EqualizerPreset : 'off', custom: { bandsDb: bands, preampDb: preamp } };
}

/** Within the band range, in half decibels. */
export function clampGain(gainDb: number): number {
  return Math.round(Math.max(-equalizerRangeDb, Math.min(equalizerRangeDb, gainDb)) * 2) / 2;
}
