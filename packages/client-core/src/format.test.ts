import { describe, expect, it } from 'vitest'
import { formatDuration, formatRemaining, formatTotalDuration } from './format.js'

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
})

describe('formatTotalDuration', () => {
  it('rounds to minutes, at least one', () => {
    expect(formatTotalDuration(10_000)).toBe('1 min')
    expect(formatTotalDuration(42 * 60_000 + 20_000)).toBe('42 min')
    expect(formatTotalDuration(65 * 60_000)).toBe('1 hr 5 min')
    expect(formatTotalDuration(120 * 60_000)).toBe('2 hr')
  })
})
