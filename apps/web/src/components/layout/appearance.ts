export const themes = [
  { id: 'squirmy', name: 'Squirmy' },
  { id: 'pulpo', name: 'Pulpo' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'forest', name: 'Forest' },
  { id: 'ember', name: 'Ember' },
] as const

export const modes = ['system', 'light', 'dark'] as const
export type Theme = typeof themes[number]['id']
export type ColorMode = typeof modes[number]

export type Appearance = { theme: Theme; mode: ColorMode }
const defaultAppearance: Appearance = { theme: 'squirmy', mode: 'system' }
const storageKey = 'squirmy.appearance'
const listeners = new Set<() => void>()
let appearance: Appearance | undefined

function readAppearance(value: string | null): Appearance {
  try {
    const saved = JSON.parse(value ?? '{}') as Partial<Appearance> | null
    return {
      theme: themes.find(theme => theme.id === saved?.theme)?.id ?? defaultAppearance.theme,
      mode: modes.find(mode => mode === saved?.mode) ?? defaultAppearance.mode,
    }
  } catch {
    return defaultAppearance
  }
}

function loadAppearance() {
  try {
    return readAppearance(window.localStorage.getItem(storageKey))
  } catch {
    return defaultAppearance
  }
}

export function getAppearance(): Appearance {
  return appearance ??= loadAppearance()
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function applyAppearance(value: Appearance) {
  appearance = value
  const { theme, mode } = value
  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.colorMode = mode
  for (const listener of listeners) listener()
}

export function initializeAppearance() {
  applyAppearance(loadAppearance())
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) applyAppearance(loadAppearance())
  })
}

export function saveAppearance(value: Appearance) {
  applyAppearance(value)
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // The choice still applies in this tab if persistence is unavailable.
  }
}
