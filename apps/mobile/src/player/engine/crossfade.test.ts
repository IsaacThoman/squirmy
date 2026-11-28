import { describe, expect, it } from 'vitest';
import { crossfadeOptions, readCrossfade } from './crossfade';

describe('crossfade setting', () => {
  it('offers Off and 2 to 12 seconds', () => {
    expect(crossfadeOptions[0]).toEqual({ value: 0, label: 'Off' });
    expect(crossfadeOptions.slice(1).map(option => option.value)).toEqual([2, 3, 4, 5, 6, 8, 10, 12]);
    expect(crossfadeOptions[3].label).toBe('4 Seconds');
  });

  it('reads back what it offers, and Off for anything else', () => {
    expect(readCrossfade(6)).toBe(6);
    expect(readCrossfade(null)).toBe(0);
    expect(readCrossfade(7)).toBe(0);
    expect(readCrossfade('6')).toBe(0);
  });
});
