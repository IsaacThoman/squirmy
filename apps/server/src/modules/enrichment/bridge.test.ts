import { describe, expect, it } from 'vitest'
import type { MbArtistSummary, MbReleaseGroupSummary } from '../metadata/musicbrainz.js'
import { confidentArtist, confidentReleaseGroup } from './bridge.js'

const group = (mbid: string, title: string, artist: string, score: number, type: MbReleaseGroupSummary['type'] = 'album'): MbReleaseGroupSummary => ({
  mbid, title, type, primaryType: null, secondaryTypes: [], disambiguation: '', artistCredit: [{ name: artist, mbid: `${artist}-id`, joinPhrase: '' }],
  artistName: artist, date: null, year: null, score,
})
const artist = (mbid: string, name: string, score: number): MbArtistSummary => ({ mbid, name, sortName: name, disambiguation: '', type: null, country: null, score })

describe('confidentReleaseGroup', () => {
  const wanted = { title: 'Miraculé', artist: 'Niro', type: 'album' as const }

  it('accepts the one exact hit', () => {
    expect(confidentReleaseGroup([group('a', 'Miraculé', 'Niro', 100), group('b', 'Miraculé (Réédition)', 'Niro', 80)], wanted)).toBe('a')
  })

  it('ignores case, accents and an edition suffix on either side', () => {
    expect(confidentReleaseGroup([group('a', 'MIRACULE', 'niro', 95)], { ...wanted, title: 'Miraculé (Deluxe Edition)' })).toBe('a')
  })

  it('rejects a low score, another title or another artist', () => {
    expect(confidentReleaseGroup([group('a', 'Miraculé', 'Niro', 70)], wanted)).toBeNull()
    expect(confidentReleaseGroup([group('a', 'Miraculé Tour', 'Niro', 100)], wanted)).toBeNull()
    expect(confidentReleaseGroup([group('a', 'Miraculé', 'Nero', 100)], wanted)).toBeNull()
  })

  it('narrows several exact hits by type, and rejects them when that does not decide', () => {
    const single = group('s', 'Miraculé', 'Niro', 100, 'single')
    expect(confidentReleaseGroup([group('a', 'Miraculé', 'Niro', 100), single], wanted)).toBe('a')
    expect(confidentReleaseGroup([group('a', 'Miraculé', 'Niro', 100), group('b', 'Miraculé', 'Niro', 98)], wanted)).toBeNull()
  })
})

describe('confidentArtist', () => {
  it('accepts only an unambiguous exact name', () => {
    expect(confidentArtist([artist('a', 'Alvvays', 100), artist('b', 'Always', 60)], 'alvvays')).toBe('a')
    expect(confidentArtist([artist('a', 'Nirvana', 100), artist('b', 'Nirvana', 100)], 'Nirvana')).toBeNull()
    expect(confidentArtist([artist('a', 'Nirvana UK', 100)], 'Nirvana')).toBeNull()
  })
})
