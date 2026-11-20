export type LyricLine = { timeMs: number; text: string }

const stamp = /\[(\d+):(\d{1,2}(?:\.\d{1,3})?)\]/g

/** Parses LRC text into time-ordered lines. Lines without a timestamp are dropped. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const text = raw.replace(stamp, '').trim()
    for (const [, minutes, seconds] of raw.matchAll(stamp)) {
      lines.push({ timeMs: Math.round((Number(minutes) * 60 + Number(seconds)) * 1000), text })
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

/** Index of the line being sung at `positionMs`, or -1 before the first. */
export function activeLine(lines: LyricLine[], positionMs: number): number {
  let index = -1
  for (const [i, line] of lines.entries()) {
    if (line.timeMs > positionMs) break
    index = i
  }
  return index
}
