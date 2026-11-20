import type { OrganizeTemplateToken } from '@squirmy/contracts'

type TokenName = OrganizeTemplateToken['token']

/**
 * A fictional track for showing what a naming template produces. It is on the second disc of
 * a two-disc album, so every token has a value and the example shows each one.
 */
export const SAMPLE_TRACK: Record<TokenName, string> = {
  albumartist: 'Mira Vale', artist: 'Mira Vale feat. Lune Park', album: 'Blue Hour', year: '2019', disc: '2', track: '03', title: 'Paper Boats', ext: 'flac',
}

/**
 * The path `template` gives the sample track, filling in only the server's `tokens`. Every
 * sample token has a value, so `[optional]` parts are kept. Null for a template these tokens
 * cannot fill or whose brackets do not match; the server says why when it is saved.
 */
export function templateExample(template: string, tokens: readonly TokenName[]): string | null {
  const known = new Set<string>(tokens)
  let out = ''
  let depth = 0
  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]
    if (char === '{') {
      const end = template.indexOf('}', index)
      const name = end === -1 ? '' : template.slice(index + 1, end)
      if (!known.has(name)) return null
      out += SAMPLE_TRACK[name as TokenName]
      index = end
    } else if (char === '[') {
      depth += 1
    } else if (char === ']') {
      if (depth === 0) return null
      depth -= 1
    } else if (char === '}') {
      return null
    } else {
      out += char
    }
  }
  return depth === 0 ? out : null
}
