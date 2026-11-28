/** Lowercase, without accents, so "cafe" finds "Café". */
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * How well `query` matches `text` as a fuzzy subsequence, higher being better, or null when its
 * letters are not all there in order. Letters that start a word and letters in a run count more,
 * so "nxt" finds "Next song", and "sh" puts "Shuffle" before "Show queue" only by its run.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = fold(query).replace(/\s+/g, '')
  if (!needle) return 0
  const haystack = fold(text)
  let score = 0
  let from = 0
  let previous = -2
  for (const letter of needle) {
    const at = haystack.indexOf(letter, from)
    if (at < 0) return null
    const wordStart = at === 0 || /[\s\-/(]/.test(haystack[at - 1])
    score += 1 + (wordStart ? 4 : 0) + (at === previous + 1 ? 3 : 0)
    // The farther the letters are spread, the weaker the match.
    score -= Math.min(3, (at - from) * 0.1)
    previous = at
    from = at + 1
  }
  // A match from the very start of the text reads as what was meant.
  if (haystack.startsWith(needle)) score += 6
  return score
}

/** The items whose words match `query`, best first; ties keep their order. */
export function fuzzyFilter<T>(items: readonly T[], query: string, words: (item: T) => string[]): T[] {
  return items
    .map((item, index) => {
      const scores = words(item).map(text => fuzzyScore(query, text)).filter((score): score is number => score !== null)
      return { item, index, score: scores.length ? Math.max(...scores) : null }
    })
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item)
}
