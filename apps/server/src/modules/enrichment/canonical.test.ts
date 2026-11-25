import { describe, expect, it } from 'vitest'
import type { MbReleaseSummary } from '../metadata/musicbrainz.js'
import { chooseCanonicalRelease, maxNamedEditions, namedEditions, standardRelease } from './canonical.js'

type Edition = [mbid: string, status: string | null, tracks: number, date: string | null, format: string, disambiguation?: string]

function editions(rows: Edition[]): MbReleaseSummary[] {
  return rows.map(([mbid, status, trackCount, date, format, disambiguation = '']) => ({
    mbid, title: 'Album', status, country: null, barcode: null, disambiguation, artistCredit: [], artistName: 'Artist',
    date, year: date ? Number(date.slice(0, 4)) : null,
    media: format.split('+').map((one) => ({ format: one, trackCount: trackCount / format.split('+').length })),
    trackCount, labels: [], releaseGroup: null,
  }))
}

describe('chooseCanonicalRelease', () => {
  it.each<[string, Edition[], string]>([
    ['the earliest CD of the common track count over vinyl and later reissues', [
      ['vinyl-1969', 'official', 17, '1969-09-26', '12" Vinyl'],
      ['cd-1987', 'official', 17, '1987-10-21', 'CD'],
      ['cd-2009', 'official', 17, '2009-09-09', 'CD'],
      ['deluxe-2019', 'official', 40, '2019-09-27', 'CD+CD'],
    ], 'cd-1987'],
    ['the common track count over an earlier bonus-track edition', [
      ['jp-bonus', 'official', 13, '1997-05-21', 'CD'],
      ['eu', 'official', 12, '1997-06-16', 'CD'],
      ['us', 'official', 12, '1997-07-01', 'CD'],
    ], 'eu'],
    ['official over an earlier promotional copy and a bootleg', [
      ['promo', 'promotion', 12, '1997-04-01', 'CD'],
      ['bootleg', 'bootleg', 12, '1997-01-01', 'CD'],
      ['official', 'official', 12, '1997-06-16', 'Digital Media'],
    ], 'official'],
    ['promotional copies when that is all there is', [
      ['bootleg', 'bootleg', 10, '2001-01-01', 'CD'],
      ['promo', 'promotion', 10, '2001-02-01', 'CD'],
    ], 'promo'],
    ['digital media counts as preferred, and a dated release beats an undated one', [
      ['undated', 'official', 9, null, 'Digital Media'],
      ['cassette', 'official', 9, '2015-01-01', 'Cassette'],
      ['digital', 'official', 9, '2015-03-01', 'Digital Media'],
    ], 'digital'],
    ['a track count tie goes to the count released first', [
      ['ten-late', 'official', 10, '2012-01-01', 'CD'],
      ['eleven-early', 'official', 11, '2010-01-01', 'CD'],
      ['ten-later', 'official', 10, '2013-01-01', 'CD'],
      ['eleven-later', 'official', 11, '2014-01-01', 'CD'],
    ], 'eleven-early'],
    ['the MBID breaks a full tie', [
      ['b-same', 'official', 8, '2020-05-05', 'CD'],
      ['a-same', 'official', 8, '2020-05-05', 'CD'],
    ], 'a-same'],
    // ADÉLA's PRIMA: the Atmos release's MBID sorts first, and its songs are other recordings.
    ['the album’s own mix over a Dolby Atmos release and a clean one', [
      ['0257-atmos', 'official', 11, '2026-09-04', 'Digital Media', 'Dolby Atmos mix'],
      ['0506-clean', 'official', 11, '2026-09-04', 'Digital Media', 'clean'],
      ['8d7b-explicit', 'official', 11, '2026-09-04', 'Digital Media', 'explicit'],
    ], '8d7b-explicit'],
    ['an instrumental release only when nothing else qualifies', [
      ['a-instrumentals', 'official', 10, '2019-01-01', 'Digital Media', 'instrumentals'],
    ], 'a-instrumentals'],
    ['no status counts as better than promotional', [
      ['promo', 'promotion', 7, '2000-01-01', 'CD'],
      ['unknown', null, 7, '2001-01-01', 'CD'],
    ], 'unknown'],
  ])('picks %s', (_name, rows, expected) => {
    expect(chooseCanonicalRelease(editions(rows))?.mbid).toBe(expected)
  })

  it('has nothing to pick from an empty group', () => {
    expect(chooseCanonicalRelease([])).toBeNull()
  })
})

describe('namedEditions', () => {
  const titled = (title: string, rows: Edition[]) => editions(rows).map((release) => ({ ...release, title }))

  it('keeps each edition with a title of its own once, as the group would choose it', () => {
    // So Close to What as MusicBrainz lists it, trimmed: the deluxe is titled apart.
    const releases = [
      ...titled('So Close to What', [
        ['cd', 'official', 13, '2025-02-21', 'CD'],
        ['vinyl', 'official', 13, '2025-02-21', '12" Vinyl'],
        ['jp-cd', 'official', 14, '2025-02-26', 'CD'],
        ['digital-16', 'official', 16, '2025-02-21', 'Digital Media', '16 Track version'],
        ['exclusive-21', 'official', 21, '2025-03-05', 'Digital Media', 'exclusive 21 track digital download'],
      ]),
      ...titled('SO CLOSE TO WHAT???', [
        ['deluxe-atmos', 'official', 21, '2025-11-21', 'Digital Media', 'Dolby Atmos mix, deluxe'],
        ['deluxe-clean', 'official', 21, '2025-11-21', 'Digital Media', 'deluxe, clean'],
        ['deluxe-vinyl', 'official', 21, '2026-03-13', '12" Vinyl+12" Vinyl', 'deluxe'],
        ['deluxe-digital', 'official', 21, '2025-11-21', 'Digital Media', 'deluxe'],
        ['deluxe-cd', 'official', 21, '2025-11-21', 'CD', 'deluxe'],
        ['deluxe-empty', 'official', 0, '2025-11-21', '12" Vinyl', 'deluxe'],
      ]),
    ]
    // More deluxe pressings than standard ones: the album is still the standard edition.
    expect(chooseCanonicalRelease(releases)!.mbid).toBe('exclusive-21')
    expect(standardRelease({ title: 'So Close to What', releases })!.mbid).toBe('cd')
    // A group whose releases are all titled otherwise picks from them all.
    expect(standardRelease({ title: 'So close to what (album)', releases })!.mbid).toBe('exclusive-21')
    expect(namedEditions({ title: 'So Close to What', releases }).map((release) => release.mbid)).toEqual(['deluxe-cd'])
  })

  it('lists several editions by date, and none for a group of one title', () => {
    const releases = [
      ...titled('Midnights', [['standard', 'official', 13, '2022-10-21', 'Digital Media']]),
      ...titled('Midnights (The Til Dawn Edition)', [['til-dawn', 'official', 23, '2023-05-26', 'Digital Media']]),
      ...titled('Midnights (3am Edition)', [['3am', 'official', 20, '2022-10-21', 'Digital Media']]),
    ]
    expect(namedEditions({ title: 'Midnights', releases }).map((release) => release.mbid)).toEqual(['3am', 'til-dawn'])
    expect(namedEditions({ title: 'Midnights', releases: releases.slice(0, 1) })).toEqual([])
    expect(namedEditions({ title: 'Midnights', releases: [] })).toEqual([])
  })

  it('takes no typo, censored pressing, other mix or lesser status for an edition', () => {
    const releases = [
      ...titled('Blue Hour', [['standard', 'official', 10, '2020-01-01', 'CD']]),
      // Another case and quote marks, the same songs: one title.
      ...titled('BLUE HOUR', [['shouted', 'official', 10, '2020-01-01', 'CD']]),
      ...titled('Blue Hour (Clean)', [['clean', 'official', 10, '2020-01-01', 'Digital Media']]),
      ...titled('Blue Hour (Dolby Atmos)', [['atmos', 'official', 10, '2020-01-01', 'Digital Media']]),
      ...titled('Blue Hour (Demos)', [['bootleg', 'bootleg', 12, '2021-01-01', 'CD']]),
      // Only case apart, but more songs: an edition.
      ...titled('BLUE HOUR!', [['loud', 'official', 12, '2021-01-01', 'Digital Media']]),
      ...titled('Blue Hour (Remastered)', [['remaster', 'official', 10, '2024-01-01', 'Digital Media']]),
    ]
    expect(namedEditions({ title: 'Blue Hour', releases }).map((release) => release.mbid)).toEqual(['loud', 'remaster'])
  })

  it('keeps at most a few', () => {
    const releases = [
      ...titled('Live', [['standard', 'official', 10, '2000-01-01', 'CD']]),
      ...Array.from({ length: maxNamedEditions + 3 }, (_, index) => titled(`Live, Night ${index + 1}`, [[`night-${index + 1}`, 'official', 10 + index, `200${index}-02-01`, 'CD']])).flat(),
    ]
    expect(namedEditions({ title: 'Live', releases })).toHaveLength(maxNamedEditions)
  })
})
