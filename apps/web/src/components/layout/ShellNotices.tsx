import { Volume2, WifiOff } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/feedback'
import { useAudioUnlock } from '@/player/engine/engine-context'
import { useRealtime } from '@/realtime/realtime-context'

/**
 * Small floating notices above the player: a lost connection, audio held back by the browser.
 * The status regions stay mounted while empty: screen readers announce what appears in a live
 * region they already know, and often miss one that arrives with its text. They sit above
 * dialogs, so "Enable audio" can be pressed from Now Playing, where play is pressed most.
 */
export function ShellNotices() {
  const { down } = useRealtime()
  const audio = useAudioUnlock()
  const stack = useRef<HTMLDivElement>(null)
  // Toasts stack above the notices (`--notices-height`), so neither covers the other.
  useEffect(() => {
    const element = stack.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    // With a notice showing, the toasts keep the same 0.5rem gap from it as the notices keep from each other.
    const measure = () => root.style.setProperty('--notices-height', element.offsetHeight ? `calc(${element.offsetHeight}px + 0.5rem)` : '0px')
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      root.style.removeProperty('--notices-height')
    }
  }, [])
  return (
    <div ref={stack} className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--player-height,0px)+1rem)] z-[60] flex flex-col items-center gap-2 px-4">
      <div role="status" className="contents">
        {down && (
          <Notice icon={<WifiOff />}>
            <span>Reconnecting to the server…</span>
            <Spinner className="size-4" label={null} />
          </Notice>
        )}
      </div>
      <div role="status" className="contents">
        {audio.blocked && (
          <Notice icon={<Volume2 />}>
            <span>Your browser is holding back audio</span>
            <Button size="sm" variant="primary" className="-my-0.5 -mr-1.5 h-7" onClick={audio.unlock}>Enable audio</Button>
          </Notice>
        )}
      </div>
    </div>
  )
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="pointer-events-auto flex min-h-9 animate-enter items-center gap-2.5 rounded-lg border bg-popover py-1.5 pl-3 pr-3 text-sm text-popover-foreground shadow-lg [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}{children}
    </div>
  )
}
