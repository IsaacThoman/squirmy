import { useSyncExternalStore } from 'react'
import { CROSSFADE_SECONDS } from './engine/crossfade-engine'
import { DEFAULT_EQUALIZER, parseEqualizer, type Equalizer } from './engine/equalizer'

/**
 * How this browser plays, rather than the account: the equalizer and the output device belong
 * to the speakers or headphones in front of it, and crossfade is per device on every app.
 * Kept in localStorage, per browser, and followed across its tabs; `EngineProvider` applies
 * them to the page's engine.
 */
export type AudioSettings = {
  equalizer: Equalizer
  /** `setSinkId`'s id of the output device, '' for the system's default. */
  outputDevice: string
  /** Seconds songs crossfade over, 0 for off (`CROSSFADE_SECONDS`). */
  crossfadeSeconds: number
}

export const AUDIO_STORAGE_KEY = 'squirmy.audio'
const DEFAULTS: AudioSettings = { equalizer: DEFAULT_EQUALIZER, outputDevice: '', crossfadeSeconds: 0 }

let current: AudioSettings = DEFAULTS
let started = false
const listeners = new Set<() => void>()

function read(): AudioSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(AUDIO_STORAGE_KEY) ?? 'null') as Partial<Record<keyof AudioSettings, unknown>> | null
    if (!stored || typeof stored !== 'object') return DEFAULTS
    return {
      equalizer: parseEqualizer(stored.equalizer),
      outputDevice: typeof stored.outputDevice === 'string' ? stored.outputDevice : '',
      crossfadeSeconds: (CROSSFADE_SECONDS as readonly unknown[]).includes(stored.crossfadeSeconds) ? stored.crossfadeSeconds as number : 0,
    }
  } catch {
    return DEFAULTS
  }
}

function start() {
  if (started) return
  started = true
  current = read()
  if (typeof window === 'undefined') return
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== AUDIO_STORAGE_KEY) return
    current = read()
    for (const listener of listeners) listener()
  })
}

export function getAudioSettings(): AudioSettings {
  start()
  return current
}

export function setAudioSettings(patch: Partial<AudioSettings>) {
  start()
  current = { ...current, ...patch }
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Without storage the choice lasts until the page is closed.
  }
  for (const listener of listeners) listener()
}

export function subscribeAudioSettings(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reads the stored settings again, as a new page would (tests). */
export function reloadAudioSettings() {
  current = read()
  for (const listener of listeners) listener()
}

export function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(subscribeAudioSettings, getAudioSettings, () => DEFAULTS)
}
