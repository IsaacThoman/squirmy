import { describe, expect, it } from 'vitest';
import { spokenDuration, trackDuration } from './duration';

describe('trackDuration', () => {
  it('shows m:ss, and an en dash when the length is unknown', () => {
    expect(trackDuration(187_400)).toBe('3:07');
    expect(trackDuration(0)).toBe('–');
  });
});

describe('spokenDuration', () => {
  it('says the length in words', () => {
    expect(spokenDuration(187_400)).toBe('3 minutes 7 seconds');
    expect(spokenDuration(60_000)).toBe('1 minute');
    expect(spokenDuration(41_000)).toBe('41 seconds');
    expect(spokenDuration(0)).toBeNull();
  });
});
