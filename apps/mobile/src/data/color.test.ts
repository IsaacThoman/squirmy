import { describe, expect, it } from 'vitest';
import { fallbackTint, shade } from './color';

describe('shade', () => {
  it('darkens a color so white text stays legible on it', () => {
    expect(shade('#ffffff')).toBe('#8c8c8c');
    expect(shade('#4a6fa5', 0.5)).toBe('#253853');
  });

  it('falls back without a usable color', () => {
    expect(shade(null)).toBe(fallbackTint);
    expect(shade('red')).toBe(fallbackTint);
  });
});
