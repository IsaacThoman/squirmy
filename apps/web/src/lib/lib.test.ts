import { describe, expect, it } from 'vitest'
import { safeNext } from '@/auth/session'
import { deviceName } from './device'
import { formatDuration, formatRelative, formatTotalDuration } from './format'
import { activeLine, parseLrc } from './lyrics'
import { dropIndex, moveItem } from './reorder'

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(225_000)).toBe('3:45')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatTotalDuration(34 * 60_000)).toBe('34 min')
    expect(formatTotalDuration(72 * 60_000)).toBe('1 hr 12 min')
  })

  it('formats relative times against a fixed now', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(formatRelative('2026-11-18T12:00:00Z', now)).toBe('2 days ago')
    expect(formatRelative('2026-11-20T11:59:50Z', now)).toBe('just now')
  })
})

describe('lyrics', () => {
  it('parses LRC and finds the line being sung', () => {
    const lines = parseLrc('[00:12.50] Second\n[00:01.00]First\nno stamp\n[01:00.00][01:30.00]Chorus')
    expect(lines.map(line => line.text)).toEqual(['First', 'Second', 'Chorus', 'Chorus'])
    expect(lines[1].timeMs).toBe(12_500)
    expect(activeLine(lines, 500)).toBe(-1)
    expect(activeLine(lines, 13_000)).toBe(1)
    expect(activeLine(lines, 95_000)).toBe(3)
  })
})

describe('reorder', () => {
  it('moves items and clamps drops', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(dropIndex(1, 60, 56, 3)).toBe(2)
    expect(dropIndex(1, -500, 56, 3)).toBe(0)
    expect(dropIndex(0, 20, 56, 3)).toBe(0)
  })
})

describe('device', () => {
  it('names browsers after the user agent', () => {
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe('Chrome on macOS')
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Windows')
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS')
  })
})

describe('sign-in redirects', () => {
  it('only follow paths inside the app', () => {
    expect(safeNext('/admin/users?tab=1')).toBe('/admin/users?tab=1')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })
})
