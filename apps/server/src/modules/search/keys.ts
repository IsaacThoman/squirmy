/**
 * Text keys the search module compares and looks up by. Everything is built on
 * `matchKey`, so case, punctuation and diacritics never matter.
 */
import { sql, type SQL } from 'drizzle-orm'
import { matchKey } from '../../lib/text.js'

// Words that describe an edition of an album or a recording rather than what it is.
// A bracketed or dashed suffix is dropped only when every word in it is one of these (or
// a number) and at least one is a strong word: "Deluxe Edition", "2011 Remaster",
// "25th Anniversary", "Explicit". Words that name different music (live, remix, demo,
// acoustic, mono, radio edit, "Taylor's Version") are not on the list, so those suffixes stay.
// A suffix crediting guests ("feat. Pharrell Williams") is dropped too: Deezer puts those
// in titles, tags usually put them in the artist.
const strongEditionWords = new Set([
  'deluxe', 'expanded', 'special', 'anniversary', 'remaster', 'remastered', 'remasters', 'explicit', 'clean', 'edited',
  'bonus', 'collectors', 'limited', 'legacy', 'reissue', 'standard',
])
// Regional editions ("Japanese Deluxe Edition") are editions too, but only beside a strong
// word: "(Japan)" alone may be part of a title.
const weakEditionWords = new Set(['super', 'edition', 'version', 'track', 'tracks', 'digital', 'the', 'and', 'japan', 'japanese'])
const ordinal = /^\d+(st|nd|rd|th)?$/

const suffixes = [/\s*\(([^()]*)\)\s*$/, /\s*\[([^[\]]*)\]\s*$/, /\s+[-–—]\s+([^-–—()[\]]+)$/]

function isIgnorable(text: string): boolean {
  const words = matchKey(text).split(' ').filter(Boolean)
  if (['feat', 'ft', 'featuring'].includes(words[0] ?? '')) return true
  return words.some((word) => strongEditionWords.has(word))
    && words.every((word) => strongEditionWords.has(word) || weakEditionWords.has(word) || ordinal.test(word))
}

/**
 * The title without trailing edition qualifiers and guest credits: "OK Computer (Deluxe
 * Edition)" is "OK Computer", "Get Lucky (feat. Pharrell Williams)" is "Get Lucky".
 */
export function editionFreeTitle(title: string): string {
  let current = title.trim()
  for (;;) {
    const match = suffixes.map((pattern) => pattern.exec(current)).find((found) => found && isIgnorable(found[1]!))
    if (!match) return current
    const stripped = current.slice(0, match.index).trim()
    if (!matchKey(stripped)) return current
    current = stripped
  }
}

/**
 * The query without trailing edition words, when it has some and something is left:
 * "ok computer deluxe" is "ok computer". Search providers match every word, so an edition
 * the provider names differently ("OKNOTOK") or not at all would otherwise find nothing.
 */
export function editionFreeQuery(query: string): string {
  const words = query.split(' ')
  let end = words.length
  while (end > 1 && (strongEditionWords.has(words[end - 1]!) || weakEditionWords.has(words[end - 1]!) || ordinal.test(words[end - 1]!))) end--
  const dropped = words.slice(end)
  return dropped.some((word) => strongEditionWords.has(word)) ? words.slice(0, end).join(' ') : query
}

/** `matchKey` of `editionFreeTitle`: the key two editions of one album or song share. */
export function editionFreeKey(title: string): string {
  return matchKey(editionFreeTitle(title))
}

/** The smallest string greater than every string that starts with `prefix`, in C collation. */
export function prefixEnd(prefix: string): string {
  const last = prefix.codePointAt(prefix.length - 1)!
  return prefix.slice(0, prefix.length - String.fromCodePoint(last).length) + String.fromCodePoint(last + 1)
}

/** One `text[]` parameter, for `unnest(...)` and `= any(...)`. Null entries stay null. */
export function textArray(values: readonly (string | null)[]): SQL {
  const items = values.map((value) => (value === null ? 'NULL' : `"${value.replace(/["\\]/g, '\\$&')}"`))
  return sql`${`{${items.join(',')}}`}::text[]`
}
