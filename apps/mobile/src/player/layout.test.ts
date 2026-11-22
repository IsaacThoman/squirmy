import { describe, expect, it } from 'vitest';
import { metadataHeight } from './layout';

describe('metadataHeight', () => {
  it('is the designed 60 pt at the default text size', () => {
    expect(metadataHeight(1)).toBe(60);
  });

  it('grows with larger text', () => {
    expect(metadataHeight(1.2)).toBeGreaterThan(60);
  });

  it('stops growing once both lines reach their caps', () => {
    expect(metadataHeight(3.1)).toBe(metadataHeight(1.6));
    expect(metadataHeight(1.6)).toBe(Math.ceil(36 * 1.3 + 3 + 20 * 1.6));
  });
});
