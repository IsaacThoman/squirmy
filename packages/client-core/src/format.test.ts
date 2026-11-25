import { describe, expect, it } from 'vitest'
import { albumTypeLabel, formatBytes, formatDuration, formatReleaseDate, formatRemaining, formatTotalDuration, plural, releaseSubtitle, songCountLabel } from './format.js'

describe('formatDuration', () => {
  it('formats m:ss and drops partial seconds', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(7_999)).toBe('0:07')
    expect(formatDuration(187_000)).toBe('3:07')
    expect(formatDuration(4_500_000)).toBe('75:00')
  })

  it('treats negative and non-finite input as 0', () => {
    expect(formatDuration(-5000)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('formatRemaining', () => {
  it('shows the time left with a minus sign', () => {
    expect(formatRemaining(60_000, 143_000)).toBe('−1:23')
    expect(formatRemaining(200_000, 143_000)).toBe('−0:00')
  })

  it('rounds up, so the last second is not shown as −0:00', () => {
    expect(formatRemaining(142_200, 143_000)).toBe('−0:01')
    expect(formatRemaining(143_000, 143_000)).toBe('−0:00')
    expect(formatRemaining(60_400, 143_000)).toBe('−1:23')
  })
})

describe('formatTotalDuration', () => {
  it('rounds to minutes, at least one', () => {
    expect(formatTotalDuration(10_000)).toBe('1 min')
    expect(formatTotalDuration(42 * 60_000 + 20_000)).toBe('42 min')
    expect(formatTotalDuration(65 * 60_000)).toBe('1 hr 5 min')
    expect(formatTotalDuration(120 * 60_000)).toBe('2 hr')
  })
})

describe('release presentation', () => {
  it('names release types', () => {
    expect(albumTypeLabel('ep')).toBe('EP')
    expect(albumTypeLabel('other')).toBe('Release')
  })

  it('gives a release tile its year and type, or the type alone', () => {
    expect(releaseSubtitle({ year: 2021, type: 'album' })).toBe('2021 · Album')
    expect(releaseSubtitle({ year: null, type: 'soundtrack' })).toBe('Soundtrack')
  })

  it('formats release dates as written, without inventing a day or shifting it', () => {
    expect(formatReleaseDate('2021-11-22')).toBe('Nov 22, 2021')
    expect(formatReleaseDate('2021-01-01')).toBe('Jan 1, 2021')
    expect(formatReleaseDate('2021-11')).toBe('Nov 2021')
    expect(formatReleaseDate('2021')).toBe('2021')
    expect(formatReleaseDate('2021-11-22T00:00:00Z')).toBe('Nov 22, 2021')
    expect(formatReleaseDate('2021-13')).toBe('2021')
    expect(formatReleaseDate('soon')).toBeNull()
  })

  // The same answer in every time zone: the package's test script runs this file under several.
  it('keeps dates that read a day or a year early west of UTC when parsed as instants', () => {
    expect(formatReleaseDate('1994-01-01')).toBe('Jan 1, 1994')
    expect(formatReleaseDate('1995-02-06')).toBe('Feb 6, 1995')
    expect(formatReleaseDate('1985')).toBe('1985')
    expect(formatReleaseDate('1984-09')).toBe('Sep 1984')
    expect(formatReleaseDate('1999-00-00')).toBe('1999')
    expect(formatReleaseDate('1999-04-00')).toBe('Apr 1999')
  })
})

describe('plural', () => {
  it('groups the digits and picks the noun', () => {
    expect(plural(1, 'song')).toBe('1 song')
    expect(plural(0, 'song')).toBe('0 songs')
    expect(plural(1234, 'song')).toBe('1,234 songs')
    expect(plural(2, 'person', 'people')).toBe('2 people')
  })
})

describe('songCountLabel', () => {
  it('counts the songs and their length once the list is complete', () => {
    expect(songCountLabel(1234, { durationMs: 3 * 3_600_000 })).toBe('1,234 songs · 3 hr')
    expect(songCountLabel(1, { durationMs: 200_000, separator: ', ' })).toBe('1 song, 3 min')
  })

  it('says there are more, and no length, while pages are still to come', () => {
    expect(songCountLabel(60, { complete: false, durationMs: 3 * 3_600_000 })).toBe('60+ songs')
    expect(songCountLabel(1200, { complete: false, durationMs: 0 })).toBe('1,200+ songs')
  })
})

describe('formatBytes', () => {
  it('counts in 1024s, with one decimal under ten', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2_500)).toBe('2.4 KB')
    expect(formatBytes(4_200_000)).toBe('4.0 MB')
    expect(formatBytes(123_000_000)).toBe('117 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(64 * 1024 ** 3)).toBe('64 GB')
  })

  it('reads nonsense as nothing', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
