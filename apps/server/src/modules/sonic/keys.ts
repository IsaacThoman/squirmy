/**
 * Musical keys: reading the notations taggers write, naming keys, and how well two keys
 * mix. A key is a tonic pitch class (0 = C … 11 = B) and a mode.
 *
 * Notations read: names ("A minor", "Am", "Amin", "F#", "Bbm", "C♯ major"), Camelot
 * ("8A" is A minor, "8B" C major; A minor, B major) and Open Key ("1m" is A minor, "1d"
 * C major). Mixed In Key, Rekordbox and Traktor write one of these.
 */
import type { Mode } from './dsp/key.js'

export type MusicalKey = { tonic: number; mode: Mode }

const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']

const mod12 = (value: number) => ((value % 12) + 12) % 12

/** Position on the circle of fifths of a major key, as the Camelot and Open Key wheels number it from C. */
const fifths = (majorTonic: number) => mod12(majorTonic * 7)
/** The major key sharing the key's notes (A minor → C major). */
const relativeMajor = (key: MusicalKey) => (key.mode === 'major' ? key.tonic : mod12(key.tonic + 3))

/** Camelot code: "8A" for A minor, "8B" for C major. */
export function camelot(key: MusicalKey): string {
  return `${mod12(fifths(relativeMajor(key)) + 7) + 1}${key.mode === 'minor' ? 'A' : 'B'}`
}

/** "A minor", "F# major". */
export function keyName(key: MusicalKey): string {
  return `${(key.mode === 'major' ? MAJOR_NAMES : MINOR_NAMES)[key.tonic]} ${key.mode}`
}

function fromWheel(number: number, minor: boolean, offset: number): MusicalKey | null {
  if (!Number.isInteger(number) || number < 1 || number > 12) return null
  const major = mod12((number - offset) * 7)
  return minor ? { tonic: mod12(major - 3), mode: 'minor' } : { tonic: major, mode: 'major' }
}

/** Reads a key tag; null for anything it cannot read ("o", "off", "unknown", noise). */
export function parseKey(value: string | null | undefined): MusicalKey | null {
  const text = value?.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
  if (!text) return null
  const wheel = /^0?(\d{1,2})\s*([abdm])$/i.exec(text)
  if (wheel) {
    const number = Number(wheel[1])
    const letter = wheel[2]!.toLowerCase()
    // Camelot counts from 8 (C major is 8B), Open Key from 1 (C major is 1d).
    if (letter === 'a' || letter === 'b') return fromWheel(number, letter === 'a', 8)
    return fromWheel(number, letter === 'm', 1)
  }
  const named = /^([a-g])\s*(#|b|sharp|flat)?\s*(.*)$/i.exec(text)
  if (!named) return null
  const accidental = named[2]?.toLowerCase()
  const rest = named[3]!.trim().toLowerCase().replace(/^[-_]/, '')
  const tonic = mod12(LETTERS[named[1]!.toLowerCase()]! + (accidental === '#' || accidental === 'sharp' ? 1 : accidental === 'b' || accidental === 'flat' ? -1 : 0))
  if (rest === '') return { tonic, mode: named[1] === named[1]!.toLowerCase() && !accidental ? 'minor' : 'major' }
  if (/^(m|min|minor|moll)$/.test(rest)) return { tonic, mode: 'minor' }
  if (/^(maj|major|dur)$/.test(rest)) return { tonic, mode: 'major' }
  return null
}

/**
 * Steps between two keys on the Camelot wheel: 0 the same key, 1 a fifth apart or the
 * relative major/minor (mixes cleanly), 2 a diagonal move, more is a clash.
 */
export function keyDistance(a: MusicalKey, b: MusicalKey): number {
  const steps = Math.abs(fifths(relativeMajor(a)) - fifths(relativeMajor(b)))
  return Math.min(steps, 12 - steps) + (a.mode === b.mode ? 0 : 1)
}
