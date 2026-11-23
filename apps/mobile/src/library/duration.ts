import { formatDuration } from '@squirmy/client-core';

/** A song's length on an album's track list, as web shows it: `3:07`, or an en dash when the server does not know it. */
export function trackDuration(ms: number): string {
  return ms > 0 ? formatDuration(ms) : '–';
}

/** The same length for VoiceOver ("3 minutes 7 seconds"), which reads `3:07` as a time of day; nothing when unknown. */
export function spokenDuration(ms: number): string | null {
  if (!(ms > 0)) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [minutes > 0 && unit(minutes, 'minute'), (rest > 0 || minutes === 0) && unit(rest, 'second')].filter(Boolean).join(' ');
}
