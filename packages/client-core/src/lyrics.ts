/** A word of a line, as Enhanced LRC times it: from `startMs` until `endMs`, in milliseconds into the song. */
export type TimedWord = { startMs: number; endMs: number; text: string }

/**
 * A line of synced lyrics and when it is sung, in milliseconds into the song. `words` are its
 * words' times when the lyrics have them (Enhanced LRC), and joined they spell `text`, spaces
 * included. `translation` is a second line given the same time, as LRC files carry a translation
 * or a romanization.
 */
export type TimedLyric = { startMs: number; text: string; words?: TimedWord[]; translation?: string }

const stamp = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g
const wordStamp = /<(\d+):(\d+(?:[.:]\d+)?)>/g
const offsetTag = /^\[offset:\s*([+-]?\d+)\]/im
/** The longest a line's last word is held when nothing says when it ends. */
const lastWordMs = 1000

const ms = (minutes: string, seconds: string) => (Number(minutes) * 60 + Number(seconds.replace(':', '.'))) * 1000

/** LRC text without Enhanced LRC's word stamps (`<mm:ss.xx>`), so a reader that knows only lines reads it as before. */
export function stripWordStamps(lrc: string): string {
  if (!/<\d+:\d+/.test(lrc)) return lrc
  return lrc.split('\n').map((line) => {
    if (!new RegExp(wordStamp.source).test(line)) return line
    return line.replace(wordStamp, '').replace(/[ \t]{2,}/g, ' ').replace(/^((?:\[[^\]]*\])+)[ \t]+/, '$1').trimEnd()
  }).join('\n')
}

/**
 * The words of a line's text, timed by its word stamps: each word runs from its stamp to the next.
 * Text before the first stamp starts with the line. Null when the line has no word stamps.
 */
function timedWords(body: string, lineMs: number): { text: string; words: TimedWord[] } | null {
  const marks = [...body.matchAll(wordStamp)]
  if (!marks.length) return null
  const pieces: { startMs: number; text: string }[] = []
  const lead = body.slice(0, marks[0]!.index)
  if (lead.trim()) pieces.push({ startMs: lineMs, text: lead })
  for (const [index, mark] of marks.entries()) {
    const from = mark.index + mark[0].length
    const text = body.slice(from, marks[index + 1]?.index ?? body.length)
    pieces.push({ startMs: ms(mark[1]!, mark[2]!), text })
  }
  // A last stamp with nothing after it says when the line's last word ends.
  const closing = pieces.at(-1)!.text.trim() ? null : pieces.pop()!.startMs
  if (!pieces.length) return null
  const first = pieces[0]!
  first.text = first.text.trimStart()
  const last = pieces.at(-1)!
  last.text = last.text.trimEnd()
  const words = pieces.map((piece, index) => ({
    startMs: Math.round(piece.startMs),
    endMs: Math.round(pieces[index + 1]?.startMs ?? closing ?? Number.NaN),
    text: piece.text,
  }))
  return { text: words.map(word => word.text).join('').replace(/\s+/g, ' '), words }
}

/**
 * The timed lines of LRC text, in order. A line with several timestamps appears at each, and
 * lines without one, such as tags like `[ar:…]`, are dropped. Empty timed lines are kept: they
 * mark instrumental gaps. `[offset:…]` shifts every time as LRC defines it, in milliseconds:
 * a positive offset makes the lines come earlier.
 *
 * Enhanced LRC's word stamps (`[00:12.00]<00:12.00>Paper <00:12.40>boats<00:13.10>`) give a
 * line its `words`; a last word with no stamp after it ends with the next line, held at most a
 * second. Two lines with the same time are one line and its translation, as LRC files put a
 * translation or a romanization under the original.
 */
export function parseLrc(lrc: string): TimedLyric[] {
  const offset = Number(offsetTag.exec(lrc)?.[1] ?? 0)
  const shift = (at: number) => Math.max(0, Math.round(at) - offset)
  const lines: TimedLyric[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(stamp)]
    if (!times.length) continue
    const body = raw.replace(stamp, '')
    const first = ms(times[0]![1]!, times[0]![2]!)
    const timed = timedWords(body, first)
    const text = timed ? timed.text.trim() : body.trim()
    for (const [, minutes, seconds] of times) {
      const at = ms(minutes!, seconds!)
      const line: TimedLyric = { text, startMs: shift(at) }
      // Word stamps are the first time's; the line's other times move them along with it.
      if (timed) line.words = timed.words.map(word => ({ ...word, startMs: shift(word.startMs + at - first), endMs: shift(word.endMs + at - first) }))
      lines.push(line)
    }
  }
  lines.sort((a, b) => a.startMs - b.startMs)
  const merged: TimedLyric[] = []
  for (const line of lines) {
    const before = merged.at(-1)
    if (before && before.startMs === line.startMs && before.text && line.text && before.translation === undefined && before.text !== line.text) {
      before.translation = line.text
      continue
    }
    merged.push(line)
  }
  for (const [index, line] of merged.entries()) {
    const next = merged[index + 1]?.startMs
    for (const word of line.words ?? []) {
      if (Number.isNaN(word.endMs)) word.endMs = Math.min(word.startMs + lastWordMs, next ?? Infinity)
      word.endMs = Math.max(word.startMs, word.endMs)
    }
  }
  return merged
}

/**
 * How far through `line`'s words the song is at `positionMs`: the index of the word being sung
 * (-1 before the first, the count once the last has ended) and the share of it sung, 0 to 1.
 */
export function wordProgress(words: readonly TimedWord[], positionMs: number): { index: number; fraction: number } {
  let index = -1
  for (const [i, word] of words.entries()) {
    if (word.startMs > positionMs) break
    index = i
  }
  if (index < 0) return { index: -1, fraction: 0 }
  const word = words[index]!
  if (positionMs >= word.endMs) {
    return index === words.length - 1 ? { index: words.length, fraction: 0 } : { index, fraction: 1 }
  }
  const length = word.endMs - word.startMs
  return { index, fraction: length > 0 ? (positionMs - word.startMs) / length : 1 }
}
