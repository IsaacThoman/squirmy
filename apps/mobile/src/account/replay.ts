import { plural } from '@squirmy/client-core';
import type { ReplayPeriod, ReplayStats } from '@squirmy/contracts';

/** The periods the phone offers, as the web's Replay names them. Year in Review stays on the web. */
export type ReplayChoice = Exclude<ReplayPeriod, 'review'>;
export const replayPeriods: { value: ReplayChoice; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
];

/** How long was listened, as the web says it: "<1 min", "45 min", "12 h 5 min". */
export function listeningTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return ms > 0 ? '<1 min' : '0 min';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours.toLocaleString()} h${remainder ? ` ${remainder} min` : ''}` : `${minutes} min`;
}

/** "Nov 1, 2026 – Nov 28, 2026", or "All time" for a window with no start, in the device's time zone. */
export function replayWindow({ window }: Pick<ReplayStats, 'window'>, timeZone: string): string {
  if (!window.start) return 'All time';
  const date = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone }).format(new Date(iso));
  // The window ends at the start of the next day: its last day is the one before.
  return `${date(window.start)} – ${date(new Date(new Date(window.end).getTime() - 1).toISOString())}`;
}

/** The period before, for comparison: "Previous period: 3 h 10 min · 42 plays". */
export function previousLine({ previous }: Pick<ReplayStats, 'previous'>): string | null {
  return previous ? `Previous period: ${listeningTime(previous.msPlayed)} · ${plural(previous.plays, 'play')}` : null;
}

/** The streak line: "4 days in a row, 9 at most". */
export function streakLine({ streak }: Pick<ReplayStats, 'streak'>): string {
  return `${plural(streak.current, 'day')} in a row now, ${plural(streak.longest, 'day')} at most`;
}

/** A ranked row's detail: "12 plays · 40 min". */
export const rankDetail = (row: { plays: number; msPlayed: number }) => `${plural(row.plays, 'play')} · ${listeningTime(row.msPlayed)}`;

/** The tops shown on the phone: five of each. */
export const replayTop = 5;
