import { describe, expect, it } from 'vitest';
import { contrastRatio, fadedText, over } from './faded';

// The pages and highlights faded text sits on, per appearance (theme.ts): the page (black on
// iOS, near-black on Android), the surface, and the current row's translucent selection.
const backgrounds = {
  dark: ['#000000', '#111014', '#242326', '#1C1B1E', over('#CBC1FF', 0x1f / 255, '#1C1B1E')],
  light: ['#FFFFFF', '#F1EFF2', '#FAF9FA', over('#5B439E', 0x17 / 255, '#FAF9FA')],
};

describe('faded song text', () => {
  it('keeps at least 3:1 against every background it is drawn on', () => {
    for (const appearance of ['dark', 'light'] as const) {
      for (const color of Object.values(fadedText[appearance])) {
        for (const background of backgrounds[appearance]) {
          expect(contrastRatio(color, background), `${appearance} ${color} on ${background}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('measures contrast as WCAG does', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});
