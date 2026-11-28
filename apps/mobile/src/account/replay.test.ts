import type { ReplayStats } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { listeningTime, previousLine, rankDetail, replayWindow, streakLine } from './replay';

describe('replay', () => {
  it('says listening time as the web does', () => {
    expect([listeningTime(0), listeningTime(30_000), listeningTime(45 * 60_000), listeningTime(125 * 60_000), listeningTime(120 * 60_000)])
      .toEqual(['0 min', '<1 min', '45 min', '2 h 5 min', '2 h']);
  });

  it('names the window by its first and last day, or all time', () => {
    expect(replayWindow({ window: { start: null, end: '2026-11-29T00:00:00.000Z' } }, 'UTC')).toBe('All time');
    expect(replayWindow({ window: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-29T00:00:00.000Z' } }, 'UTC'))
      .toMatch(/Nov 1, 2026 – Nov 28, 2026/);
  });

  it('describes the previous period, the streak and a ranked row', () => {
    const previous = { plays: 1, msPlayed: 61 * 60_000, start: null, end: '2026-11-01T00:00:00.000Z' } as ReplayStats['previous'];
    expect(previousLine({ previous })).toBe('Previous period: 1 h 1 min · 1 play');
    expect(previousLine({ previous: null })).toBeNull();
    expect(streakLine({ streak: { current: 1, longest: 9 } })).toBe('1 day in a row now, 9 days at most');
    expect(rankDetail({ plays: 12, msPlayed: 40 * 60_000 })).toBe('12 plays · 40 min');
  });
});
