import { describe, expect, it } from 'vitest'
import type { MbReleaseSummary } from '../metadata/musicbrainz.js'
import { chooseCanonicalRelease } from './canonical.js'

type Edition = [mbid: string, status: string | null, tracks: number, date: string | null, format: string]

function editions(rows: Edition[]): MbReleaseSummary[] {
  return rows.map(([mbid, status, trackCount, date, format]) => ({
    mbid, title: 'Album', status, country: null, barcode: null, disambiguation: '', artistCredit: [], artistName: 'Artist',
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
