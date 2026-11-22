import { describe, expect, it } from 'vitest'
import { albumTypeLabel, formatDuration, formatReleaseDate, formatRemaining, formatTotalDuration, releaseSubtitle } from './format.js'

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
})
