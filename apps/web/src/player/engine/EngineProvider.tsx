import { useMemo, useState, type ReactNode } from 'react'
import { EngineContext } from './engine-context'
import { WebPlayerEngine } from './web-engine'

/** One audio engine per page. Nothing plays until something drives it. */
export function EngineProvider({ children }: { children: ReactNode }) {
  const [standard] = useState(() => new WebPlayerEngine())
  const [replacement, replace] = useState<WebPlayerEngine | null>(null)
  const slot = useMemo(() => ({ engine: replacement ?? standard, replace }), [replacement, standard])
  return <EngineContext value={slot}>{children}</EngineContext>
}
