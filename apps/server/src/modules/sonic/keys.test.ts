import { describe, expect, it } from 'vitest'
import { camelot, keyDistance, keyName, parseKey } from './keys.js'

describe('musical keys', () => {
  it.each([
    ['Am', 'A minor'], ['A minor', 'A minor'], ['amin', 'A minor'], ['a', 'A minor'], ['A', 'A major'],
    ['F#', 'F# major'], ['F♯m', 'F# minor'], ['Bbm', 'Bb minor'], ['Eb major', 'Eb major'], ['Db', 'Db major'],
    ['C# maj', 'Db major'], ['A flat minor', 'G# minor'],
    // Camelot (Mixed In Key, Rekordbox) and Open Key (Traktor).
    ['8A', 'A minor'], ['8B', 'C major'], ['1A', 'G# minor'], ['1B', 'B major'], ['12B', 'E major'], ['08a', 'A minor'],
    ['1m', 'A minor'], ['1d', 'C major'], ['2d', 'G major'],
  ])('reads %s as %s', (written, name) => {
    expect(keyName(parseKey(written)!)).toBe(name)
  })

  it.each(['', 'o', 'off', 'unknown', '13A', 'H', 'C wobbly'])('reads %j as no key', (written) => {
    expect(parseKey(written)).toBeNull()
  })

  it('writes Camelot codes', () => {
    expect(camelot({ tonic: 9, mode: 'minor' })).toBe('8A')
    expect(camelot({ tonic: 0, mode: 'major' })).toBe('8B')
    expect(camelot({ tonic: 7, mode: 'major' })).toBe('9B')
    expect(camelot({ tonic: 11, mode: 'major' })).toBe('1B')
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ['major', 'minor'] as const) expect(parseKey(camelot({ tonic, mode }))).toEqual({ tonic, mode })
    }
  })

  it('measures steps on the Camelot wheel', () => {
    const c = parseKey('C')!
    expect(keyDistance(c, c)).toBe(0)
    expect(keyDistance(c, parseKey('G')!)).toBe(1)
    expect(keyDistance(c, parseKey('F')!)).toBe(1)
    expect(keyDistance(c, parseKey('Am')!)).toBe(1)
    expect(keyDistance(c, parseKey('Em')!)).toBe(2)
    expect(keyDistance(c, parseKey('D')!)).toBe(2)
    expect(keyDistance(c, parseKey('F#')!)).toBe(6)
    expect(keyDistance(parseKey('11B')!, parseKey('2B')!)).toBe(3)
  })
})
