import { describe, expect, it } from 'vitest';
import {
  automaticPreamp, clampGain, defaultEqualizer, equalizerBands, equalizerCurve, equalizerOptions, formatGain, readEqualizer,
  tvEqualizerOptions, type EqualizerSetting,
} from './equalizer';

const custom = (bandsDb: number[], preampDb: number | null = null): EqualizerSetting => ({ preset: 'custom', custom: { bandsDb, preampDb } });

describe('equalizerCurve', () => {
  it('is nothing while off, whatever the custom curve holds', () => {
    expect(equalizerCurve(defaultEqualizer)).toBeNull();
    expect(equalizerCurve({ ...custom([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]), preset: 'off' })).toBeNull();
  });

  it('turns a preset down by its largest boost', () => {
    expect(equalizerCurve({ ...defaultEqualizer, preset: 'bassBoost' })).toEqual({ bandsDb: [6, 5.5, 4.5, 3, 1.5, 0, 0, 0, 0, 0], preampDb: -6 });
    // A curve that only cuts needs no preamp.
    expect(equalizerCurve({ ...defaultEqualizer, preset: 'bassReducer' })?.preampDb).toBe(0);
  });

  it('plays the custom curve with its own preamp, or the automatic one', () => {
    const bands = [0, 0, 0, 0, 4, 0, -3, 0, 0, 0];
    expect(equalizerCurve(custom(bands))).toEqual({ bandsDb: bands, preampDb: -4 });
    expect(equalizerCurve(custom(bands, 2))).toEqual({ bandsDb: bands, preampDb: 2 });
  });

  it('is nothing for a flat custom curve, which leaves the sound as it is', () => {
    expect(equalizerCurve(custom(equalizerBands.map(() => 0)))).toBeNull();
    expect(equalizerCurve(custom(equalizerBands.map(() => 0), -3))).toEqual({ bandsDb: equalizerBands.map(() => 0), preampDb: -3 });
  });
});

describe('readEqualizer', () => {
  it('keeps what was stored', () => {
    const stored = custom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], -10);
    expect(readEqualizer(stored)).toEqual(stored);
  });

  it('falls back to off for anything it cannot read', () => {
    expect(readEqualizer(null)).toEqual(defaultEqualizer);
    expect(readEqualizer('loud')).toEqual(defaultEqualizer);
    expect(readEqualizer({ preset: 'mystery' }).preset).toBe('off');
    // A curve of the wrong length, or with something other than numbers, is flat.
    expect(readEqualizer({ preset: 'custom', custom: { bandsDb: [1, 2], preampDb: null } }).custom.bandsDb).toEqual(defaultEqualizer.custom.bandsDb);
    expect(readEqualizer({ preset: 'custom', custom: { bandsDb: equalizerBands.map(() => Number.NaN), preampDb: 'x' } }).custom)
      .toEqual(defaultEqualizer.custom);
  });

  it('keeps gains in range, in half decibels', () => {
    expect(readEqualizer(custom([40, -40, 0.3, 0.26, 0, 0, 0, 0, 0, 0], 99)).custom).toEqual({ bandsDb: [12, -12, 0.5, 0.5, 0, 0, 0, 0, 0, 0], preampDb: 12 });
  });
});

describe('labels', () => {
  it('formats gains as the editor shows them', () => {
    expect(formatGain(0)).toBe('0 dB');
    expect(formatGain(3)).toBe('+3 dB');
    expect(formatGain(-6.5)).toBe('−6.5 dB');
    expect(formatGain(0.2)).toBe('0 dB');
  });

  it('names the bands in hertz and kilohertz, written and spoken', () => {
    expect(equalizerBands.map(band => band.label)).toEqual(['31 Hz', '63 Hz', '125 Hz', '250 Hz', '500 Hz', '1 kHz', '2 kHz', '4 kHz', '8 kHz', '16 kHz']);
    expect(equalizerBands[0].spoken).toBe('31 hertz');
    expect(equalizerBands[9].spoken).toBe('16 kilohertz');
  });

  it('offers Custom on the phone and the presets alone on the TV', () => {
    expect(equalizerOptions.map(option => option.label)).toEqual(['Off', 'Bass Boost', 'Bass Reducer', 'Treble Boost', 'Vocal', 'Late Night', 'Custom']);
    expect(tvEqualizerOptions.some(option => option.value === 'custom')).toBe(false);
  });

  it('works out the automatic preamp and the range', () => {
    expect(automaticPreamp([0, -3, 0])).toBe(0);
    expect(automaticPreamp([2, 7.5, -12])).toBe(-7.5);
    expect(clampGain(12.4)).toBe(12);
  });
});
