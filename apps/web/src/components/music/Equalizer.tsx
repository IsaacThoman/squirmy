import { cn } from '@/lib/utils'

/** Three bouncing bars for the track that is playing; still bars when paused. */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span role="img" aria-label={playing ? 'Playing' : 'Paused'} className={cn('flex h-3.5 items-end gap-[2px] text-accent', className)}>
      {[0, 280, 140].map(delay => (
        <span
          key={delay}
          className={cn('w-[3px] rounded-full bg-current', playing ? 'equalizer-bar h-full' : 'h-1/2')}
          style={{ animationDelay: `-${delay}ms` }}
        />
      ))}
    </span>
  )
}
