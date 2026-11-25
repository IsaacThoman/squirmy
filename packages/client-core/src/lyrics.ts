/** A line of synced lyrics and when it is sung, in milliseconds into the song. */
export type TimedLyric = { startMs: number; text: string }

const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g
const offsetTag = /^\[offset:\s*([+-]?\d+)\]/im

/**
 * The timed lines of LRC text, in order. A line with several timestamps appears at each, and
 * lines without one, such as tags like `[ar:…]`, are dropped. Empty timed lines are kept: they
 * mark instrumental gaps. `[offset:…]` shifts every time as LRC defines it, in milliseconds:
 * a positive offset makes the lines come earlier.
 */
export function parseLrc(lrc: string): TimedLyric[] {
  const offset = Number(offsetTag.exec(lrc)?.[1] ?? 0)
  const lines: TimedLyric[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(stamp)]
    if (!times.length) continue
    const text = raw.replace(stamp, '').trim()
    for (const [, minutes, seconds] of times) {
      const at = (Number(minutes) * 60 + Number(seconds!.replace(':', '.'))) * 1000
      lines.push({ text, startMs: Math.max(0, Math.round(at) - offset) })
    }
  }
  return lines.sort((a, b) => a.startMs - b.startMs)
}
