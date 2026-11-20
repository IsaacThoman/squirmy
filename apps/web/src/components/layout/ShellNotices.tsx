import { Volume2, WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/feedback'
import { useAudioUnlock } from '@/player/engine/engine-context'
import { useRealtime } from '@/realtime/realtime-context'

/** Small floating notices above the player: a lost connection, audio held back by the browser. */
export function ShellNotices() {
  const { down } = useRealtime()
  const audio = useAudioUnlock()
  if (!down && !audio.blocked) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--player-height)+1rem)] z-40 flex flex-col items-center gap-2 px-4">
      {down && (
        <Notice icon={<WifiOff />}>
          <span>Reconnecting to the server…</span>
          <Spinner className="size-4 text-muted" label="Reconnecting" />
        </Notice>
      )}
      {audio.blocked && (
        <Notice icon={<Volume2 />}>
          <span>Your browser is holding back audio</span>
          <Button size="sm" variant="primary" className="-my-1 -mr-2.5" onClick={audio.unlock}>Enable audio</Button>
        </Notice>
      )}
    </div>
  )
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div role="status" className="pointer-events-auto flex min-h-10 animate-enter items-center gap-2.5 rounded-full bg-floating py-1.5 pl-3.5 pr-4 text-[13px] font-semibold shadow-float backdrop-blur-xl backdrop-saturate-150 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted">
      {icon}{children}
    </div>
  )
}
