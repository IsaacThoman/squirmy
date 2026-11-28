/**
 * The 10-band graphic equalizer of the browser engines (docs/audio-engine.md, "Equalizer"):
 * peaking filters an octave apart from 31 Hz to 16 kHz, each ±12 dB, and presets with the
 * iOS engine's names. A preamp of minus the largest boost keeps the limiter from working on
 * every loud moment.
 */

/** Centre frequencies, in Hz. */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000] as const
export const EQ_MAX_DB = 12
/** About an octave wide, so neighbouring bands meet near their half-gain points. */
export const EQ_Q = 1.41

export type EqPreset = 'off' | 'bassBoost' | 'bassReducer' | 'trebleBoost' | 'vocal' | 'lateNight' | 'custom'

/** One gain per band, in dB. */
export type EqGains = readonly number[]

export const EQ_PRESETS: readonly { id: Exclude<EqPreset, 'custom'>; label: string; gains: EqGains }[] = [
  // The iOS engine's presets, with the same curves (apps/mobile/src/player/engine/equalizer.ts).
  { id: 'off', label: 'Off', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bassBoost', label: 'Bass boost', gains: [6, 5.5, 4.5, 3, 1.5, 0, 0, 0, 0, 0] },
  { id: 'bassReducer', label: 'Bass reducer', gains: [-6, -5.5, -4.5, -3, -1.5, 0, 0, 0, 0, 0] },
  { id: 'trebleBoost', label: 'Treble boost', gains: [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 6] },
  { id: 'vocal', label: 'Vocal', gains: [-2, -2, -1, 0, 1.5, 3, 3.5, 2.5, 1, 0] },
  // Fuller bass and treble, which the ear hears less of at a low volume.
  { id: 'lateNight', label: 'Late night', gains: [5, 4, 2.5, 1, 0, 0, 0, 1, 2.5, 4] },
]

/** Preset ids this setting had before it took the iOS names, so a stored choice survives. */
const RENAMED: Record<string, EqPreset> = { flat: 'off', bass: 'bassBoost', treble: 'trebleBoost', loudness: 'lateNight' }

export const FLAT: EqGains = EQ_PRESETS[0]!.gains

/** What this browser's equalizer is set to: a preset, or the user's own bands, which are kept while a preset plays. */
export type Equalizer = { preset: EqPreset; custom: EqGains }

export const DEFAULT_EQUALIZER: Equalizer = { preset: 'off', custom: FLAT }

/** The bands `equalizer` plays. */
export function eqGains(equalizer: Equalizer): EqGains {
  if (equalizer.preset === 'custom') return equalizer.custom
  return EQ_PRESETS.find(preset => preset.id === equalizer.preset)?.gains ?? FLAT
}

export function isFlat(gains: EqGains): boolean {
  return gains.every(gain => gain === 0)
}

/** The preamp in dB: minus the largest boost, so a song's peaks stay about where they were. */
export function preampDb(gains: EqGains): number {
  return 0 - Math.max(0, ...gains)
}

/** A stored value made safe: ten finite gains within range, a known preset. */
export function parseEqualizer(value: unknown): Equalizer {
  if (!value || typeof value !== 'object') return DEFAULT_EQUALIZER
  const { preset: stored, custom } = value as { preset?: unknown; custom?: unknown }
  const preset = typeof stored === 'string' ? RENAMED[stored] ?? stored : stored
  const known = preset === 'custom' || EQ_PRESETS.some(candidate => candidate.id === preset)
  const bands = Array.isArray(custom) && custom.length === EQ_BANDS.length && custom.every(gain => typeof gain === 'number' && Number.isFinite(gain))
    ? custom.map(gain => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, gain as number)))
    : FLAT
  return { preset: known ? preset as EqPreset : 'off', custom: bands }
}
