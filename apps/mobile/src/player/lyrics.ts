import type { Lyrics } from '@squirmy/contracts';

export type LyricLine = { text: string; startMs: number | null };

const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const offsetTag = /^\[offset:\s*([+-]?\d+)\]/im;

/**
 * Lines to show for a track's lyrics: timed lines in order when synced LRC exists, the
 * plain text otherwise. A line with several timestamps appears at each; tags such as
 * `[ar:…]` are dropped, and `[offset:…]` shifts every time as LRC defines (positive is earlier).
 */
export function lyricLines(lyrics: Pick<Lyrics, 'synced' | 'plain'> | null | undefined): { lines: LyricLine[]; synced: boolean } {
  if (lyrics?.synced) {
    const offset = Number(offsetTag.exec(lyrics.synced)?.[1] ?? 0);
    const lines: LyricLine[] = [];
    for (const raw of lyrics.synced.split(/\r?\n/)) {
      const times = [...raw.matchAll(stamp)];
      if (!times.length) continue;
      const text = raw.replace(stamp, '').trim();
      for (const [, minutes, seconds] of times) {
        lines.push({ text, startMs: Math.max(0, Math.round((Number(minutes) * 60 + Number(seconds!.replace(':', '.'))) * 1000) - offset) });
      }
    }
    lines.sort((a, b) => a.startMs! - b.startMs!);
    // Empty timed lines mark instrumental gaps; they keep the timing but are not shown.
    const shown = lines.filter(line => line.text);
    if (shown.length) return { lines: shown, synced: true };
  }
  const plain = (lyrics?.plain ?? '').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  return { lines: plain.map(text => ({ text, startMs: null })), synced: false };
}

/** The index of the line sung at `positionMs`, or -1 before the first. */
export function activeLine(lines: readonly LyricLine[], positionMs: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index]!.startMs;
    if (start === null || start > positionMs) break;
    active = index;
  }
  return active;
}
