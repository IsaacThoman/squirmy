import { useSyncExternalStore } from 'react'
import { colorThemeStylesheet, DEFAULT_COLOR_THEME_ID, findColorTheme, type ThemeAppearance } from './color-themes'

/**
 * How this browser shows the app: light, dark or the system's choice, and a color theme.
 * It is kept in localStorage, per browser, and applied to <html>. `public/appearance.js` applies the saved
 * value before the app loads, so a reload never flashes the wrong colors; keep the two in step.
 */
export type AppearanceMode = 'light' | 'dark' | 'system'
export type Appearance = { mode: AppearanceMode; theme: string }

export const APPEARANCE_STORAGE_KEY = 'squirmy.appearance'
const STYLE_ELEMENT_ID = 'squirmy-color-theme'
const MODES: readonly AppearanceMode[] = ['light', 'dark', 'system']
const fallback: Appearance = { mode: 'system', theme: DEFAULT_COLOR_THEME_ID }

function read(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Partial<Appearance>
    return {
      mode: MODES.includes(saved.mode as AppearanceMode) ? saved.mode as AppearanceMode : fallback.mode,
      theme: findColorTheme(saved.theme).id,
    }
  } catch {
    return fallback
  }
}

let current: Appearance = fallback
let started = false
const listeners = new Set<() => void>()

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Whether the app is showing its dark colors now, or would with this setting. */
export function resolvedAppearance(appearance: Appearance = current, systemIsDark = systemDark()): ThemeAppearance {
  return appearance.mode === 'dark' || (appearance.mode === 'system' && systemIsDark) ? 'dark' : 'light'
}

/** The browser's own bars (Safari's toolbar, Android's status bar) take the page's color. */
function syncThemeColor() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  const color = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
  if (color && meta.content !== color) meta.content = color
}

/**
 * Swaps colors at once. Otherwise every element with a color transition animates together,
 * which repaints the whole page for several frames.
 */
function withoutTransitions(change: () => void) {
  const pause = document.createElement('style')
  pause.textContent = '*,*::before,*::after{transition:none!important}'
  document.head.appendChild(pause)
  change()
  void getComputedStyle(document.body).color
  pause.remove()
}

function apply(appearance: Appearance) {
  const root = document.documentElement
  const dark = resolvedAppearance(appearance) === 'dark'
  const stylesheet = colorThemeStylesheet(findColorTheme(appearance.theme))
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (root.classList.contains('dark') === dark && (existing?.textContent ?? '') === stylesheet) return syncThemeColor()
  withoutTransitions(() => {
    root.classList.toggle('dark', dark)
    if (!stylesheet) {
      existing?.remove()
      return
    }
    const element = existing ?? document.createElement('style')
    element.id = STYLE_ELEMENT_ID
    element.textContent = stylesheet
    if (!existing) document.head.appendChild(element)
  })
  syncThemeColor()
}

/** The choice as it is kept: with its stylesheet, so public/appearance.js can apply it without this module. */
function stored(appearance: Appearance): string {
  return JSON.stringify({ ...appearance, css: colorThemeStylesheet(findColorTheme(appearance.theme)) })
}

function save(appearance: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, stored(appearance))
  } catch {
    // Private windows may refuse storage; the choice then lasts for this page only.
  }
}

/**
 * Saves the choice again when this version would keep it differently. A theme's colors can
 * change between releases, and public/appearance.js applies whichever stylesheet is saved.
 */
function refreshSaved(appearance: Appearance) {
  try {
    const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    if (saved !== null && saved !== stored(appearance)) save(appearance)
  } catch {
    // Nothing is kept without storage.
  }
}

function set(next: Appearance) {
  current = next
  apply(next)
  save(next)
  for (const listener of listeners) listener()
}

/** Applies the saved appearance and follows the system's and other tabs' changes. Called once, from main.tsx. */
export function startAppearance() {
  current = read()
  apply(current)
  refreshSaved(current)
  if (started) return
  started = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(current))
  window.addEventListener('storage', event => {
    // A null key is another tab clearing all of storage, this choice with it.
    if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return
    current = read()
    apply(current)
    for (const listener of listeners) listener()
  })
}

export function setAppearanceMode(mode: AppearanceMode) {
  set({ ...current, mode })
}

export function setColorTheme(theme: string) {
  set({ ...current, theme: findColorTheme(theme).id })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeToSystem(listener: () => void) {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** The appearance setting, and which of light and dark it comes to right now. */
export function useAppearance(): Appearance & { resolved: ThemeAppearance } {
  const appearance = useSyncExternalStore(subscribe, () => current)
  const systemIsDark = useSyncExternalStore(subscribeToSystem, systemDark)
  return { ...appearance, resolved: resolvedAppearance(appearance, systemIsDark) }
}
