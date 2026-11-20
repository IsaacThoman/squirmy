import type { Lyrics } from '@squirmy/contracts'
import { Quote } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { activeLine, parseLrc } from '@/lib/lyrics'
import { cn } from '@/lib/utils'
import { usePosition } from '@/player/player-context'

/** Synced lyrics follow the clock and seek on click; plain lyrics just scroll. */
export function LyricsPane({ lyrics, onSeek }: { lyrics: Lyrics | null; onSeek: (ms: number) => void }) {
  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics])
  const active = usePosition(position => activeLine(lines, position))
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    container.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  if (!lyrics || lyrics.instrumental || (!lines.length && !lyrics.plain)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-quiet">
        <Quote className="size-8" />
        <p className="text-base font-semibold">{lyrics?.instrumental ? 'Instrumental' : 'No lyrics for this song'}</p>
      </div>
    )
  }

  return (
    <div ref={container} className="h-full overflow-y-auto px-2 py-[30vh] [mask-image:linear-gradient(transparent,black_18%,black_82%,transparent)] [scrollbar-width:none]">
      {lines.length
        ? lines.map((line, index) => (
          <button
            key={`${line.timeMs}-${index}`}
            type="button"
            data-active={index === active || undefined}
            aria-current={index === active || undefined}
            onClick={() => onSeek(line.timeMs)}
            className={cn(
              'block max-w-[34rem] origin-left py-2.5 text-left text-[clamp(1.5rem,2.6vw,2.1rem)] font-bold leading-tight tracking-[-0.02em] transition duration-200 hover:text-foreground/80',
              index === active ? 'text-foreground' : index < active ? 'text-quiet/70' : 'text-quiet',
            )}
          >
            {line.text || '♪'}
          </button>
        ))
        : <p className="whitespace-pre-line text-2xl font-bold leading-snug text-muted">{lyrics.plain}</p>}
      <p className="mt-8 text-xs font-semibold text-quiet">Lyrics from {lyrics.source}</p>
    </div>
  )
}
