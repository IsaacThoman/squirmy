import { CircleAlert } from 'lucide-react'
import { Spinner } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'
import type { PlayerStatus } from '@/player/status'

/**
 * The player's status line, under the song: a song skipped, playback stopped and why, a
 * radio starting. A polite live region that stays mounted while empty, so screen readers
 * announce what appears in it; it takes no room while there is nothing to say.
 */
export function PlayerStatusLine({ status, className }: { status: PlayerStatus | null | undefined; className?: string }) {
  const text = status && (status.detail ? `${status.message}. ${status.detail}` : status.message)
  return (
    <div role="status" className="contents">
      {status && (
        <p title={text ?? undefined} data-tone={status.tone} className={cn('flex min-w-0 items-center gap-1.5 text-xs text-foreground', className)}>
          {status.tone === 'busy' && <Spinner label={null} className="size-3 shrink-0 text-current" />}
          {status.tone === 'error' && <CircleAlert aria-hidden className="size-3 shrink-0 text-destructive" />}
          <span className="truncate">{text}</span>
        </p>
      )}
    </div>
  )
}
