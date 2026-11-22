import { useSyncExternalStore } from 'react'

export const palettes = ['Squirmy', 'Pulpo', 'Ocean', 'Forest', 'Ember'] as const
type Palette = (typeof palettes)[number]

export const colorModes = ['System', 'Light', 'Dark'] as const
type ColorMode = (typeof colorModes)[number]

type Appearance = { palette: Palette; mode: ColorMode }

const storageKey = 'squirmy-appearance'
const defaults: Appearance = { palette: 'Squirmy', mode: 'System' }
const listeners = new Set<() => void>()
let appearance = defaults

function parse(value: string | null): Appearance {
  try {
    const saved = JSON.parse(value ?? 'null') as Partial<Appearance> | null
    return {
      palette: saved?.palette && palettes.includes(saved.palette) ? saved.palette : defaults.palette,
      mode: saved?.mode && colorModes.includes(saved.mode) ? saved.mode : defaults.mode,
    }
  } catch {
    return defaults
  }
}

function apply(next: Appearance) {
  appearance = next
  const root = document.documentElement
  root.dataset.colorTheme = next.palette.toLowerCase()
  root.dataset.colorMode = next.mode.toLowerCase()
  listeners.forEach(listener => listener())
}

export function startAppearance() {
  let saved = null
  try {
    saved = window.localStorage.getItem(storageKey)
  } catch {
    // A browser with blocked storage can still change appearance for this tab.
  }
  apply(parse(saved))
  const sync = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) apply(parse(event.newValue))
  }
  window.addEventListener('storage', sync)
  return () => window.removeEventListener('storage', sync)
}

export function setAppearance(patch: Partial<Appearance>) {
  apply({ ...appearance, ...patch })
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(appearance))
  } catch {
    // The selected appearance remains active until the tab closes.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, () => appearance)
}
