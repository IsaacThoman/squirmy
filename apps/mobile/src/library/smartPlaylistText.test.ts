import { emptyDraft, newCondition, newGroup } from '@squirmy/client-core';
import { describe, expect, it } from 'vitest';
import { conditionCount, matchCountLabel } from './smartPlaylistText';

describe('smart playlist editor', () => {
  it('says how many songs the rules find, as the web does', () => {
    const rules = { source: 'library' as const, match: 'all' as const, conditions: [], sort: 'random' as const, limit: null };
    expect(matchCountLabel(null, undefined, false)).toBe('Finish the rules to see what matches');
    expect(matchCountLabel(rules, { trackCount: 0, durationMs: 0 }, false)).toBe('No songs match yet');
    expect(matchCountLabel(rules, { trackCount: 2, durationMs: 3_600_000 }, false)).toMatch(/^2 songs, /);
    expect(matchCountLabel(rules, undefined, true)).toBe('Couldn’t count the songs');
    expect(matchCountLabel(rules, undefined, false)).toBe('Counting songs…');
  });

  it('counts a group\'s conditions toward the limit', () => {
    const group = { ...newGroup(), conditions: [newCondition(), newCondition()] };
    expect(conditionCount({ ...emptyDraft(), rules: [newCondition(), group] })).toBe(3);
  });
});
