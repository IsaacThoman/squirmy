import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import type { WebPlayerEngine } from './web-engine'

export type EngineSlot = { engine: WebPlayerEngine; replace: (engine: WebPlayerEngine | null) => void }

export const EngineContext = createContext<EngineSlot | null>(null)

export function useEngine(): WebPlayerEngine | null {
  return useContext(EngineContext)?.engine ?? null
}

/** Makes `engine` the page's engine while the calling component is mounted (the dev page's instrumented one). */
export function useEngineOverride(engine: WebPlayerEngine) {
  const replace = useContext(EngineContext)?.replace
  useEffect(() => {
    replace?.(engine)
    return () => replace?.(null)
  }, [engine, replace])
}

/** Whether the browser is holding audio back until a gesture, and the function that releases it. */
export function useAudioUnlock(): { blocked: boolean; unlock: () => void } {
  const engine = useEngine()
  const subscribe = useCallback((listener: () => void) => engine?.subscribe(listener) ?? (() => {}), [engine])
  const blocked = useSyncExternalStore(subscribe, () => engine?.isBlocked() ?? false)
  return { blocked, unlock: () => engine?.unlock() }
}
