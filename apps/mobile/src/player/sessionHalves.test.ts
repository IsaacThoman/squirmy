import type { SavedSession } from '@squirmy/client-core';
import type { SessionQueue } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { joinSaved, sameQueue, splitSaved } from './sessionHalves';

const queue = (): SessionQueue => ({ queue: [], history: [], autoplayQueue: [], playOrder: [], playedInCycle: [] });
const saved = (q = queue()) => ({ version: 3, state: {}, queue: q, pending: [], savedAt: 10 }) as unknown as SavedSession;

describe('saved session halves', () => {
  it('joins what it split', () => {
    const session = saved();
    const { state, queue: half } = splitSaved(session);
    expect(state).not.toHaveProperty('queue');
    expect(joinSaved({ session: state }, { queue: half, tracks: [] })).toEqual({ session, tracks: [] });
  });

  it('reads a session saved whole by an earlier version', () => {
    const whole = { session: saved(), tracks: [] };
    expect(joinSaved(whole, null)).toBe(whole);
  });

  it('has nothing to restore without both halves', () => {
    expect(joinSaved(null, { queue: queue(), tracks: [] })).toBeNull();
    expect(joinSaved({ session: splitSaved(saved()).state }, null)).toBeNull();
  });
});

describe('sameQueue', () => {
  it('compares the lists by identity', () => {
    const a = queue();
    expect(sameQueue(a, { ...a })).toBe(true);
    expect(sameQueue(a, { ...a, history: [] })).toBe(false);
    expect(sameQueue(null, a)).toBe(false);
  });
});
