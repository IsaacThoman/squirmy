import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { getAudioSettings, subscribeAudioSettings } from '../audio-settings'
import { createBrowserEngine } from './choose'
import { EngineContext } from './engine-context'
import { eqGains } from './equalizer'
import { supportsOutputDevice } from './output'
import type { BrowserEngine } from './types'

/** What counts as a user gesture for starting audio. */
const GESTURES = ['pointerdown', 'keydown'] as const

declare global {
  /** The page's engine in development builds, for the end-to-end scripts. */
  interface Window { squirmyPageEngine?: BrowserEngine }
}

/** One audio engine per page. Nothing plays until something drives it. */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [standard] = useState(createBrowserEngine)
  const [replacement, replace] = useState<BrowserEngine | null>(null)
  const slot = useMemo(() => ({ engine: replacement ?? standard, replace }), [replacement, standard])
  const engine = slot.engine
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.squirmyPageEngine = engine
    return () => { delete window.squirmyPageEngine }
  }, [engine])
  // This browser's equalizer and output device, as they are set and whenever they change.
  useEffect(() => {
    let sink: string | null = null
    const apply = () => {
      const { equalizer, outputDevice } = getAudioSettings()
      engine.setEqualizer(eqGains(equalizer))
      if (!supportsOutputDevice() || outputDevice === sink) return
      sink = outputDevice
      // A device that is gone (unplugged, or its permission withdrawn) leaves the default playing.
      engine.setOutputDevice(outputDevice).catch(() => engine.setOutputDevice('').catch(() => {}))
    }
    // A device plugged back in is the chosen one again.
    const replugged = () => {
      sink = null
      apply()
    }
    apply()
    const unsubscribe = subscribeAudioSettings(apply)
    navigator.mediaDevices?.addEventListener?.('devicechange', replugged)
    return () => {
      unsubscribe()
      navigator.mediaDevices?.removeEventListener?.('devicechange', replugged)
    }
  }, [engine])
  // The first press anywhere opens the audio output, so the first song is heard as soon as it has loaded.
  useEffect(() => {
    // Without Web Audio (a test's DOM) there is no output to open.
    if (typeof AudioContext === 'undefined') return
    const warm = () => {
      engine.warm()
      for (const type of GESTURES) window.removeEventListener(type, warm, true)
    }
    for (const type of GESTURES) window.addEventListener(type, warm, true)
    return () => { for (const type of GESTURES) window.removeEventListener(type, warm, true) }
  }, [engine])
  return <EngineContext value={slot}>{children}</EngineContext>
}
