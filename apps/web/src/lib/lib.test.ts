import { describe, expect, it } from 'vitest'
import { safeNext } from '@/auth/session'
import { keyIsTaken } from '@/player/shortcuts'
import { codecsFor } from './codecs'
import { claimTabDevice, deviceName } from './device'
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
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1')).toBe('Chrome on iPhone')
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0')).toBe('Edge on macOS')
  })
})

describe('tab devices', () => {
  it('gives every tab the browser\'s name, with no tab number', async () => {
    const tab = await claimTabDevice()
    expect(tab.device.name).not.toMatch(/\(\d+\)$/)
  })

  it('marks the claim settled, so the player can read it without suspending', async () => {
    const claim = claimTabDevice()
    const tab = await claim
    await Promise.resolve()
    expect(claim).toMatchObject({ status: 'fulfilled', value: tab })
  })
})

describe('codecs', () => {
  it('lists what the browser says it can play, and Opus only in Ogg', () => {
    const plays = (types: string[]) => ({ canPlayType: (type: string) => (types.includes(type) ? 'maybe' : '') as CanPlayTypeResult })
    expect(codecsFor(plays(['audio/flac', 'audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'audio/webm; codecs="opus"']))).toEqual(['flac', 'mp3', 'aac'])
    expect(codecsFor(plays(['audio/ogg; codecs="opus"', 'audio/ogg; codecs="vorbis"']))).toEqual(['opus', 'vorbis'])
  })
})

describe('keyboard shortcuts', () => {
  const press = (key: string, target: Element, modifiers: Partial<KeyboardEvent> = {}) =>
    keyIsTaken({ key, target, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, ...modifiers })

  it('leave keys to the element that uses them', () => {
    document.body.innerHTML = '<input id="text"><button id="button">Go</button><div role="slider" id="slider"></div><div id="page"><span id="plain">Text</span></div>'
    const element = (id: string) => document.getElementById(id)!
    expect(press(' ', element('plain'))).toBe(false)
    expect(press('ArrowLeft', element('plain'))).toBe(false)
    expect(press(' ', element('text'))).toBe(true)
    expect(press('ArrowLeft', element('text'))).toBe(true)
    expect(press(' ', element('button'))).toBe(true)
    expect(press('ArrowUp', element('button'))).toBe(false)
    expect(press('ArrowRight', element('slider'))).toBe(true)
    expect(press(' ', element('plain'), { metaKey: true })).toBe(true)
  })
})

describe('sign-in redirects', () => {
  it('only follow paths inside the app', () => {
    expect(safeNext('/admin/users?tab=1')).toBe('/admin/users?tab=1')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext(null)).toBe('/')
  })

  it('read the path as the browser would, so no trick reaches another origin', () => {
    // Browsers treat a backslash as a slash and drop tabs and newlines, which makes these `//evil.example`.
    for (const next of ['/\\evil.example', '/\\/evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', '\n//evil.example', 'javascript:alert(1)', 'https:evil.example']) {
      expect(safeNext(next), JSON.stringify(next)).toBe('/')
    }
    expect(safeNext('/library/albums?sort=title#top')).toBe('/library/albums?sort=title#top')
    expect(safeNext(`${window.location.origin}/search?q=a`)).toBe('/search?q=a')
    expect(safeNext('/a/../settings')).toBe('/settings')
  })
})
