import { act, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, resolvedAppearance, setAppearanceMode, setColorTheme, startAppearance, useAppearance } from './appearance'
import { colorThemeStylesheet, findColorTheme } from './color-themes'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The device's own appearance, as matchMedia reports it. */
const system = { dark: false, listeners: new Set<() => void>() }

function setSystemDark(dark: boolean) {
  system.dark = dark
  for (const listener of [...system.listeners]) listener()
}

beforeAll(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    get matches() { return media === DARK_QUERY && system.dark },
    addEventListener: (_type: string, listener: () => void) => { if (media === DARK_QUERY) system.listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { system.listeners.delete(listener) },
  }))
})
afterAll(() => vi.unstubAllGlobals())

const root = document.documentElement
const themeStyles = () => [...document.querySelectorAll('style#squirmy-color-theme')]
const stylesheetOf = (theme: string) => colorThemeStylesheet(findColorTheme(theme))

/** What the page shows: light or dark, and the stylesheet of a theme other than the default. */
function shown() {
  const styles = themeStyles()
  if (styles.length > 1) throw new Error('more than one theme stylesheet')
  return { dark: root.classList.contains('dark'), stylesheet: styles[0]?.textContent ?? null }
}

function clearPage() {
  root.classList.remove('dark')
  for (const style of themeStyles()) style.remove()
}

const saved = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null') as unknown

/** Starts as a page load does, after an earlier visit saved `value`. */
function start(value?: object | string) {
  if (value !== undefined) localStorage.setItem(APPEARANCE_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value))
  startAppearance()
}

beforeEach(() => {
  localStorage.clear()
  clearPage()
  system.dark = false
})
afterEach(() => vi.restoreAllMocks())

describe('startAppearance', () => {
  it('shows the saved mode and color theme', () => {
    start({ mode: 'dark', theme: 'ocean' })
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('ocean') })
    expect(themeStyles()[0].parentElement).toBe(document.head)
  })

  it('adds no stylesheet for the default theme', () => {
    start({ mode: 'light', theme: 'squirmy' })
    expect(shown()).toEqual({ dark: false, stylesheet: null })
  })

  it('follows the device with nothing saved, and saves nothing', () => {
    system.dark = true
    start()
    expect(shown()).toEqual({ dark: true, stylesheet: null })
    expect(resolvedAppearance()).toBe('dark')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })

  it('shows the default theme when the saved one no longer exists', () => {
    start({ mode: 'dark', theme: 'neon', css: ':root.dark{--background:#ff00ff;}' })
    expect(shown()).toEqual({ dark: true, stylesheet: null })
  })

  it.each(['not json', 'null', '[]', '7', '{"mode":"sepia","theme":7}'])('follows the device and shows the default theme when storage holds %j', value => {
    system.dark = true
    start(value)
    expect(shown()).toEqual({ dark: true, stylesheet: null })
    setSystemDark(false)
    expect(shown()).toEqual({ dark: false, stylesheet: null })
  })

  it('follows the device when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage is off') })
    system.dark = true
    start()
    expect(shown()).toEqual({ dark: true, stylesheet: null })
  })

  it('replaces the stylesheet that was applied before it ran', () => {
    const stale = document.createElement('style')
    stale.id = 'squirmy-color-theme'
    stale.textContent = ':root:not(.dark){--background:#ff00ff;}'
    document.head.appendChild(stale)
    start({ mode: 'light', theme: 'forest' })
    expect(shown()).toEqual({ dark: false, stylesheet: stylesheetOf('forest') })
    start({ mode: 'light', theme: 'squirmy' })
    expect(shown()).toEqual({ dark: false, stylesheet: null })
  })

  it.each([
    ['a theme whose colors changed since', { mode: 'dark', theme: 'ocean', css: ':root.dark{--background:#ff00ff;}' }, { mode: 'dark', theme: 'ocean', css: stylesheetOf('ocean') }],
    ['a theme that no longer exists', { mode: 'light', theme: 'neon', css: ':root.dark{--background:#ff00ff;}' }, { mode: 'light', theme: 'squirmy', css: '' }],
  ])('brings what is saved up to date for %s, so the next load starts in the right colors', (_case, before, after) => {
    start(before)
    expect(saved()).toEqual(after)
  })
})

describe('setAppearanceMode', () => {
  it('switches between light and dark and saves the choice', () => {
    start()
    setAppearanceMode('dark')
    expect(shown()).toEqual({ dark: true, stylesheet: null })
    expect(resolvedAppearance()).toBe('dark')
    expect(saved()).toEqual({ mode: 'dark', theme: 'squirmy', css: '' })
    setAppearanceMode('light')
    expect(shown()).toEqual({ dark: false, stylesheet: null })
    expect(resolvedAppearance()).toBe('light')
    expect(saved()).toEqual({ mode: 'light', theme: 'squirmy', css: '' })
  })

  it('follows the device as it changes while set to System', () => {
    start({ mode: 'dark', theme: 'pulpo' })
    setAppearanceMode('system')
    expect(shown().dark).toBe(false)
    setSystemDark(true)
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('pulpo') })
    expect(resolvedAppearance()).toBe('dark')
    setSystemDark(false)
    expect(shown().dark).toBe(false)
    expect(saved()).toEqual({ mode: 'system', theme: 'pulpo', css: stylesheetOf('pulpo') })
  })

  it('stays as chosen when the device changes while set to Light or Dark', () => {
    start({ mode: 'light', theme: 'squirmy' })
    setSystemDark(true)
    expect(shown().dark).toBe(false)
    setAppearanceMode('dark')
    setSystemDark(false)
    expect(shown().dark).toBe(true)
  })

  it('keeps the color theme', () => {
    start({ mode: 'light', theme: 'ember' })
    setAppearanceMode('dark')
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('ember') })
  })

  it('still switches when the choice cannot be saved', () => {
    start()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage is off') })
    expect(() => setAppearanceMode('dark')).not.toThrow()
    expect(shown().dark).toBe(true)
  })
})

describe('setColorTheme', () => {
  it('applies the theme’s stylesheet and saves it with the choice', () => {
    start({ mode: 'dark', theme: 'squirmy' })
    setColorTheme('forest')
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('forest') })
    expect(saved()).toEqual({ mode: 'dark', theme: 'forest', css: stylesheetOf('forest') })
    setColorTheme('ember')
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('ember') })
  })

  it('removes the stylesheet when going back to the default theme', () => {
    start({ mode: 'light', theme: 'ocean' })
    setColorTheme('squirmy')
    expect(shown()).toEqual({ dark: false, stylesheet: null })
    expect(saved()).toEqual({ mode: 'light', theme: 'squirmy', css: '' })
  })

  it('chooses the default theme for one that does not exist', () => {
    start({ mode: 'light', theme: 'ocean' })
    setColorTheme('neon')
    expect(shown().stylesheet).toBeNull()
    expect(saved()).toEqual({ mode: 'light', theme: 'squirmy', css: '' })
  })
})

describe('another tab', () => {
  const changeElsewhere = (key: string, value: object) => {
    localStorage.setItem(key, JSON.stringify(value))
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(value) }))
  }

  it('changes this one when the appearance is changed there', () => {
    start({ mode: 'light', theme: 'squirmy' })
    changeElsewhere(APPEARANCE_STORAGE_KEY, { mode: 'dark', theme: 'ember', css: stylesheetOf('ember') })
    expect(shown()).toEqual({ dark: true, stylesheet: stylesheetOf('ember') })
    // What this tab changes next builds on what the other one chose.
    setAppearanceMode('light')
    expect(saved()).toEqual({ mode: 'light', theme: 'ember', css: stylesheetOf('ember') })
  })

  it('leaves this one alone when it saves something else', () => {
    start({ mode: 'light', theme: 'squirmy' })
    changeElsewhere('squirmy.sidebar.collapsed', { mode: 'dark', theme: 'ember' })
    expect(shown()).toEqual({ dark: false, stylesheet: null })
  })
})

describe('useAppearance', () => {
  it('gives the setting and which of light and dark it comes to', () => {
    start({ mode: 'dark', theme: 'ocean' })
    expect(renderHook(() => useAppearance()).result.current).toEqual({ mode: 'dark', theme: 'ocean', resolved: 'dark' })
  })

  it('renders again when the mode or the theme changes', () => {
    start()
    const { result } = renderHook(() => useAppearance())
    expect(result.current).toEqual({ mode: 'system', theme: 'squirmy', resolved: 'light' })
    act(() => setAppearanceMode('dark'))
    expect(result.current).toEqual({ mode: 'dark', theme: 'squirmy', resolved: 'dark' })
    act(() => setColorTheme('pulpo'))
    expect(result.current).toEqual({ mode: 'dark', theme: 'pulpo', resolved: 'dark' })
  })

  it('renders again when the device changes while set to System', () => {
    start({ mode: 'system', theme: 'squirmy' })
    const { result } = renderHook(() => useAppearance())
    expect(result.current.resolved).toBe('light')
    act(() => setSystemDark(true))
    expect(result.current).toEqual({ mode: 'system', theme: 'squirmy', resolved: 'dark' })
  })

  it('renders again when another tab changes the appearance', () => {
    start({ mode: 'light', theme: 'squirmy' })
    const { result } = renderHook(() => useAppearance())
    act(() => {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ mode: 'dark', theme: 'forest' }))
      window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY }))
    })
    expect(result.current).toEqual({ mode: 'dark', theme: 'forest', resolved: 'dark' })
  })

  it('stops listening once the component is gone', () => {
    start()
    const listening = system.listeners.size
    const { unmount } = renderHook(() => useAppearance())
    expect(system.listeners.size).toBe(listening + 1)
    unmount()
    expect(system.listeners.size).toBe(listening)
  })
})

describe('the script in index.html', () => {
  const scripts = [...readFileSync(join(import.meta.dirname, '../../index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  /** Runs it as the browser does while it reads the page, before the app's code. */
  const boot = () => (new Function(scripts[0][1]) as () => void)()

  it('is the only inline script', () => {
    expect(scripts).toHaveLength(1)
  })

  it.each([
    ['Dark and Ember', 'dark', 'ember', false],
    ['Light and Ocean', 'light', 'ocean', true],
    ['Light and the default theme', 'light', 'squirmy', true],
    ['Dark and the default theme', 'dark', 'squirmy', false],
    ['System and Pulpo on a dark device', 'system', 'pulpo', true],
    ['System and Forest on a light device', 'system', 'forest', false],
  ] as const)('shows %s just as the app saved them', (_case, mode, theme, systemDark) => {
    system.dark = systemDark
    start()
    setAppearanceMode(mode)
    setColorTheme(theme)
    const fromApp = shown()
    expect(fromApp).toEqual({ dark: mode === 'dark' || (mode === 'system' && systemDark), stylesheet: stylesheetOf(theme) || null })

    clearPage()
    boot()
    expect(shown()).toEqual(fromApp)
    expect(themeStyles()[0]?.parentElement ?? document.head).toBe(document.head)

    // The app then takes over what the script applied, without adding to it.
    startAppearance()
    expect(shown()).toEqual(fromApp)
  })

  it.each([true, false])('follows the device on a first visit (device dark: %s)', systemDark => {
    system.dark = systemDark
    boot()
    const fromScript = shown()
    clearPage()
    start()
    expect(fromScript).toEqual(shown())
    expect(fromScript).toEqual({ dark: systemDark, stylesheet: null })
  })

  it.each(['not json', 'null', '[]', '{"mode":"sepia","css":7}'])('follows the device, as the app does, when storage holds %j', value => {
    system.dark = true
    localStorage.setItem(APPEARANCE_STORAGE_KEY, value)
    boot()
    const fromScript = shown()
    clearPage()
    start()
    expect(fromScript).toEqual(shown())
    expect(fromScript).toEqual({ dark: true, stylesheet: null })
  })

  it('follows the device, as the app does, when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage is off') })
    system.dark = true
    expect(boot).not.toThrow()
    const fromScript = shown()
    clearPage()
    start()
    expect(fromScript).toEqual(shown())
    expect(fromScript).toEqual({ dark: true, stylesheet: null })
  })
})
