/**
 * Normalizes a name for comparison and trigram search: lowercase, no diacritics, no
 * punctuation, single spaces. "Beyoncé" and "beyonce", "AC/DC" and "ac dc" compare equal.
 */
// Letters that Unicode does not decompose into a base letter plus a mark.
const folded: Record<string, string> = { æ: 'ae', œ: 'oe', ø: 'o', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' }

export function matchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[æœøßđðłþı]/g, (letter) => folded[letter] ?? letter)
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Key for "the same song or album by the same artist". */
export function creditKey(artistCredit: string, title: string): string {
  return `${matchKey(artistCredit)}|${matchKey(title)}`
}

/** Sort key that ignores a leading article: "The Beatles" sorts under B. */
export function sortKey(value: string): string {
  return matchKey(value).replace(/^(the|a|an) /, '')
}
