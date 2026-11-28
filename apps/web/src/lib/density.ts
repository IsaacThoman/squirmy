import { useSyncExternalStore } from 'react'

/**
 * How tightly this browser lays out songs and cards: `comfortable` (the default) or `compact`,
 * with shorter song rows and smaller cards, so more fits on a screen. It is kept in localStorage,
 * per browser, and applied to <html> as `data-density`, which index.css's `compact:` variant
 * reads; `public/appearance.js` applies the saved value before the app loads.
 *
 * Compact applies only with a fine pointer (a mouse or trackpad): on a touch screen every row
 * keeps the 44 px a finger needs, so the variant and `useCompact` both ask for one.
 */
export type Density = 'comfortable' | 'compact'

export const DENSITY_STORAGE_KEY = 'squirmy.density'
export const DENSITIES: readonly Density[] = ['comfortable', 'compact']
const FINE_POINTER = '(pointer: fine)'

/** The height of a song row with artwork, in px: `h-11`, or `compact:h-9`. Virtualized lists place rows by it. */
export const TRACK_ROW_HEIGHT = { comfortable: 44, compact: 36 } as const
/** The narrowest a card in a grid gets, in px: `minmax(10rem, 1fr)`, or `compact:minmax(8rem, 1fr)`. */
export const CARD_MIN_WIDTH = { comfortable: 160, compact: 128 } as const

let current: Density = 'comfortable'
let started = false
const listeners = new Set<() => void>()

function read(): Density {
  try {
    return localStorage.getItem(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

function apply(density: Density) {
  document.documentElement.dataset.density = density
}

/** Applies the saved density and follows other tabs' changes. Called once, from main.tsx. */
export function startDensity() {
  current = read()
  apply(current)
  if (started) return
  started = true
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== DENSITY_STORAGE_KEY) return
    current = read()
    apply(current)
    for (const listener of listeners) listener()
  })
}

export function setDensity(density: Density) {
  current = density
  apply(density)
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, density)
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function subscribeToPointer(listener: () => void) {
  const query = window.matchMedia?.(FINE_POINTER)
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}

const finePointer = () => window.matchMedia?.(FINE_POINTER).matches ?? true

/** The density setting, as the settings show it. */
export function useDensitySetting(): Density {
  return useSyncExternalStore(subscribe, () => current, () => 'comfortable')
}

/** The density the app lays out with now: the setting, comfortable on a touch screen. */
export function effectiveDensity(density: Density, fine: boolean): Density {
  return density === 'compact' && fine ? 'compact' : 'comfortable'
}

/** The density the app lays out with now, for code that sizes what CSS draws (a virtualizer's rows). */
export function useDensity(): Density {
  const density = useDensitySetting()
  const fine = useSyncExternalStore(subscribeToPointer, finePointer, () => true)
  return effectiveDensity(density, fine)
}
