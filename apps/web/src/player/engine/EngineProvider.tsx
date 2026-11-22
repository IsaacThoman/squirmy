import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { EngineContext } from './engine-context'
import { WebPlayerEngine } from './web-engine'

/** What counts as a user gesture for starting audio. */
const GESTURES = ['pointerdown', 'keydown'] as const

/** One audio engine per page. Nothing plays until something drives it. */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [standard] = useState(() => new WebPlayerEngine())
  const [replacement, replace] = useState<WebPlayerEngine | null>(null)
  const slot = useMemo(() => ({ engine: replacement ?? standard, replace }), [replacement, standard])
  const engine = slot.engine
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
