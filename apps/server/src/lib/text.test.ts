import { describe, expect, it } from 'vitest'
import { creditKey, matchKey, sortKey } from './text.js'

describe('matchKey', () => {
  it('ignores case, diacritics and punctuation', () => {
    expect(matchKey('Beyoncé')).toBe('beyonce')
    expect(matchKey('AC/DC')).toBe('ac dc')
    expect(matchKey("  Don't   Stop  ")).toBe('dont stop')
    expect(matchKey('Simon & Garfunkel')).toBe('simon and garfunkel')
    expect(matchKey('椎名林檎')).toBe('椎名林檎')
  })

  it('builds credit keys and sort keys', () => {
    expect(creditKey('Sigur Rós', 'Ágætis byrjun')).toBe('sigur ros|agaetis byrjun')
    expect(sortKey('The Beatles')).toBe('beatles')
  })
})
