import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applySidebarWidth, clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, readSidebarCollapsed, readSidebarWidth, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH, SIDEBAR_SNAP_WIDTH, sidebarMaxWidth, writeSidebarCollapsed, writeSidebarWidth,
} from './sidebar-state'

const WIDE = 1440
/** What the page beside the sidebar must keep. */
const MAIN_VIEW = 480

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('sidebar width', () => {
  it('stays between the narrowest and the widest sidebar', () => {
    expect(clampSidebarWidth(120, WIDE)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(300, WIDE)).toBe(300)
    expect(clampSidebarWidth(900, WIDE)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('is a whole number of pixels', () => {
    expect(clampSidebarWidth(280.6, WIDE)).toBe(281)
  })

  it('opens at the default width, which a drag can reach and which is past the fold point', () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, WIDE)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(SIDEBAR_SNAP_WIDTH).toBeGreaterThan(SIDEBAR_COLLAPSED_WIDTH)
    expect(SIDEBAR_SNAP_WIDTH).toBeLessThan(SIDEBAR_MIN_WIDTH)
  })

  it.each([1440, 1024, 900, 800, 768, 700, 680])('leaves the page its minimum in a %i px window', frameWidth => {
    expect(frameWidth - sidebarMaxWidth(frameWidth)).toBeGreaterThanOrEqual(MAIN_VIEW)
    expect(frameWidth - clampSidebarWidth(SIDEBAR_MAX_WIDTH, frameWidth)).toBeGreaterThanOrEqual(MAIN_VIEW)
  })

  it('narrows the widest sidebar as the window narrows', () => {
    expect(sidebarMaxWidth(WIDE)).toBe(SIDEBAR_MAX_WIDTH)
    expect(sidebarMaxWidth(800)).toBe(320)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, 800)).toBe(320)
  })

  it('never goes under the narrowest sidebar, however small the window', () => {
    expect(sidebarMaxWidth(600)).toBe(SIDEBAR_MIN_WIDTH)
    expect(sidebarMaxWidth(0)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(300, 600)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('sizes the open sidebar through --sidebar-width', () => {
    applySidebarWidth(312)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('312px')
    document.documentElement.style.removeProperty('--sidebar-width')
  })
})

describe('the remembered sidebar', () => {
  it('starts open at the default width', () => {
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(readSidebarCollapsed()).toBe(false)
  })

  it('comes back at the width it was dragged to', () => {
    writeSidebarWidth(318)
    expect(readSidebarWidth()).toBe(318)
    writeSidebarWidth(240.4)
    expect(readSidebarWidth()).toBe(240)
  })

  it('comes back folded or open, as it was left', () => {
    writeSidebarCollapsed(true)
    expect(readSidebarCollapsed()).toBe(true)
    writeSidebarCollapsed(false)
    expect(readSidebarCollapsed()).toBe(false)
  })

  it('keeps the width while it is folded', () => {
    writeSidebarWidth(318)
    writeSidebarCollapsed(true)
    expect(readSidebarWidth()).toBe(318)
  })

  it.each(['', 'wide', 'NaN', '0', '-240', 'Infinity', '{"width":300}'])('opens at the default width when storage holds %j', saved => {
    localStorage.setItem('squirmy.sidebar.width', saved)
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('shows a saved width that no longer fits within the limits', () => {
    localStorage.setItem('squirmy.sidebar.width', '5000')
    expect(clampSidebarWidth(readSidebarWidth(), WIDE)).toBe(SIDEBAR_MAX_WIDTH)
    localStorage.setItem('squirmy.sidebar.width', '12')
    expect(clampSidebarWidth(readSidebarWidth(), WIDE)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it.each(['', 'true', 'yes', '0', 'null'])('is open when storage holds %j for folded', saved => {
    localStorage.setItem('squirmy.sidebar.collapsed', saved)
    expect(readSidebarCollapsed()).toBe(false)
  })

  it('works without storage, as in a private window', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage is off') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage is off') })
    expect(() => {
      writeSidebarWidth(300)
      writeSidebarCollapsed(true)
    }).not.toThrow()
    expect(readSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(readSidebarCollapsed()).toBe(false)
  })
})
