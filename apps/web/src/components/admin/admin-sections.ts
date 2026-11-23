/** Space between the section links (`gap-1`). */
const GAP = 4

/**
 * Which sections fit in `room`, by index, when they are `widths` wide and a More button is
 * `more` wide: the first ones that fit, and the current one (`current`) wherever it is, so the
 * header always names the page. The rest go under More.
 */
export function fitSections(widths: readonly number[], more: number, room: number, current: number): number[] {
  const all = widths.map((_, index) => index)
  const span = (indexes: number[]) => indexes.reduce((total, index) => total + widths[index]!, 0) + GAP * Math.max(0, indexes.length - 1)
  if (span(all) <= room) return all
  const left = room - more - GAP
  const shown: number[] = []
  for (const index of all) {
    // A current section further on keeps its place at the end of the row.
    const needed = current > index ? [...shown, index, current] : [...shown, index]
    if (span(needed) > left) break
    shown.push(index)
  }
  if (current >= 0 && !shown.includes(current)) shown.push(current)
  return shown
}
