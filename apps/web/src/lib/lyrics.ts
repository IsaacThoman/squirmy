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

/** How a line is drawn: its opacity, and how blurred it is in px. */
export type LineLook = { opacity: number; blur: number }

/** Lines farther than this from the sung one are only dimmed: they are well out of view while it is followed. */
export const blurReach = 8
const blurStep = 1.1
const blurMax = 5.5
const dimmed = 0.3
/** While a reader scrolls by hand, every line is readable, the sung one still a little brighter. */
const browsed = 0.62
/** After a reader stops scrolling, this long until the lyrics go back to the sung line, in ms. */
export const resumeFollowMs = 3000

/**
 * How a line looks `distance` lines from the one being sung, as the iOS app (and Apple Music)
 * draws lyrics: the sung line bright and sharp, the others dim and blurred more the farther they
 * are. While a reader scrolls (`browsing`) nothing is blurred. Before the first line is sung every
 * line waits dim, counted from just above the first.
 */
export function lineLook(distance: number, browsing: boolean): LineLook {
  if (distance === 0) return { opacity: 1, blur: 0 }
  if (browsing) return { opacity: browsed, blur: 0 }
  const away = Math.abs(distance)
  return { opacity: dimmed, blur: away <= blurReach ? Math.min(blurMax, away * blurStep) : 0 }
}
