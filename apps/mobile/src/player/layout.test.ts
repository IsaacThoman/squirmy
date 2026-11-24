import { describe, expect, it } from 'vitest';
import { metadataHeight, rhythm } from './layout';

describe('metadataHeight', () => {
  it('leaves room for a two-line title and a two-line credit at the default text size', () => {
    expect(metadataHeight(1)).toBe(115);
  });

  it('grows with larger text', () => {
    expect(metadataHeight(1.2)).toBeGreaterThan(115);
  });

  it('stops growing once both lines reach their caps', () => {
    expect(metadataHeight(3.1)).toBe(metadataHeight(1.6));
    expect(metadataHeight(1.6)).toBe(Math.ceil(2 * 36 * 1.3 + 3 + 2 * 20 * 1.6));
  });
});

describe('rhythm', () => {
  it('spaces a 6.1-inch iPhone as Apple Music does', () => {
    expect(rhythm(852)).toEqual({ artworkGap: 16, buttonsTop: 22, buttonsBottom: 32, footerTop: 12 });
  });

  it('keeps that spacing on taller screens, where the artwork grows instead', () => {
    expect(rhythm(932)).toEqual(rhythm(852));
  });

  it('tightens in step with the height on shorter screens, down to an iPhone SE', () => {
    const mini = rhythm(812);
    const se = rhythm(667);
    expect(se).toEqual({ artworkGap: 8, buttonsTop: 8, buttonsBottom: 8, footerTop: 4 });
    expect(rhythm(568)).toEqual(se);
    for (const key of Object.keys(se) as (keyof typeof se)[]) {
      expect(mini[key]).toBeGreaterThan(se[key]);
      expect(mini[key]).toBeLessThanOrEqual(rhythm(852)[key]);
    }
  });
});
