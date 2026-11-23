import { describe, expect, it } from 'vitest';
import { contextHeight, metadataHeight } from './layout';

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

describe('contextHeight', () => {
  it('is the designed 34 pt at the default text size', () => {
    expect(contextHeight(1)).toBe(34);
  });

  it('grows with larger text until the secondary cap, so its two lines stay clear of the artwork', () => {
    expect(contextHeight(1.6)).toBe(Math.ceil(31 * 1.6));
    expect(contextHeight(3.1)).toBe(contextHeight(1.6));
  });
});
