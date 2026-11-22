import type { Lyrics } from '@squirmy/contracts'
import { MessageSquareQuote } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { EmptyState } from '@/components/ui/feedback'
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
    return <EmptyState icon={<MessageSquareQuote />} title={lyrics?.instrumental ? 'Instrumental' : 'No lyrics for this song'} className="h-full justify-center" />
  }

  return (
    <div ref={container} className="scrollbar-none h-full overflow-y-auto px-1 py-[30vh] [mask-image:linear-gradient(transparent,black_18%,black_82%,transparent)]">
      {lines.length
        ? lines.map((line, index) => (
          <button
            key={`${line.timeMs}-${index}`}
            type="button"
            data-active={index === active || undefined}
            aria-current={index === active || undefined}
            onClick={() => onSeek(line.timeMs)}
            className={cn(
              'block max-w-xl rounded-md py-2 text-left text-2xl font-semibold leading-snug tracking-tight text-balance outline-none transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:text-3xl lg:leading-snug',
              index === active ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {line.text || '♪'}
          </button>
        ))
        : <p className="max-w-xl whitespace-pre-line text-xl font-medium leading-relaxed">{lyrics.plain}</p>}
      <p className="mt-8 text-xs text-muted-foreground">Lyrics from {lyrics.source}</p>
    </div>
  )
}
