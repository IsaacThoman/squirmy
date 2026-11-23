import type { Lyrics } from '@squirmy/contracts'
import { MessageSquareQuote } from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { LoadError } from '@/components/ui/query-state'
import { activeLine, parseLrc } from '@/lib/lyrics'
import { scrollBehavior } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { PlayerContext, usePosition, type LyricsStatus } from '@/player/player-context'

type LyricsPaneProps = {
  lyrics: Lyrics | null
  onSeek: (ms: number) => void
  /** Where the lyrics are; the player's by default. Without either, lyrics are there or there are none. */
  status?: LyricsStatus
  onRetry?: () => void
}

/**
 * Synced lyrics follow the clock and seek on click; plain lyrics just scroll. Synced lines are
 * one stop for Tab, a list the arrow keys move through (Home and End go to the ends), and Enter
 * or Space seeks to the focused line, so the keyboard reaches what comes after them without
 * passing every line of the song. "No lyrics" is said
 * only once the server said so: while they load the pane shows lines to come, and a failure offers
 * a retry, since the song may well have lyrics.
 */
export function LyricsPane({ lyrics, onSeek, status: given, onRetry: givenRetry }: LyricsPaneProps) {
  const player = useContext(PlayerContext)
  const status = given ?? player?.state.lyricsStatus ?? (lyrics ? 'ready' : 'none')
  const onRetry = givenRetry ?? player?.state.retryLyrics
  const lines = useMemo(() => (lyrics?.synced ? parseLrc(lyrics.synced) : []), [lyrics])
  const active = usePosition(position => activeLine(lines, position))
  const container = useRef<HTMLDivElement>(null)
  // The line the keyboard is on while it is in the list; out of it, Tab comes back to the line playing.
  const [cursor, setCursor] = useState<number | null>(null)
  const tabStop = cursor ?? Math.max(0, active)
  const lineRefs = useRef<(HTMLElement | null)[]>([])

  useEffect(() => {
    // While the keyboard moves through the lines, the list stays where it put it.
    if (cursor !== null) return
    container.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  }, [active, cursor])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = cursor ?? tabStop
    const last = lines.length - 1
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: last, PageDown: at + 5, PageUp: at - 5 }[event.key]
    if (to !== undefined) {
      event.preventDefault()
      const next = Math.max(0, Math.min(last, to))
      setCursor(next)
      lineRefs.current[next]?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSeek(lines[at]!.timeMs)
    }
  }

  if (status === 'loading' && !lyrics) {
    return (
      <div role="status" aria-label="Loading lyrics" className="flex h-full flex-col justify-center gap-5 px-1">
        {['w-3/4', 'w-1/2', 'w-2/3', 'w-2/5'].map(width => <Skeleton key={width} className={cn('h-7 max-w-xl', width)} />)}
      </div>
    )
  }
  if (status === 'failed' && !lyrics && onRetry) {
    return <div className="flex h-full flex-col justify-center"><LoadError title="The lyrics did not load" onRetry={onRetry} /></div>
  }
  if (!lyrics || lyrics.instrumental || (!lines.length && !lyrics.plain)) {
    return <EmptyState icon={<MessageSquareQuote />} title={lyrics?.instrumental ? 'Instrumental' : 'No lyrics for this song'} className="h-full justify-center" />
  }

  return (
    <div ref={container} className="scrollbar-none h-full overflow-y-auto px-1 py-[30vh] [mask-image:linear-gradient(transparent,black_18%,black_82%,transparent)]">
      {lines.length
        ? (
          <div
            role="listbox"
            aria-label="Lyrics"
            onKeyDown={onKeyDown}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setCursor(null) }}
          >
            {lines.map((line, index) => (
              <div
                key={`${line.timeMs}-${index}`}
                ref={element => { lineRefs.current[index] = element }}
                role="option"
                tabIndex={index === tabStop ? 0 : -1}
                aria-selected={index === active}
                data-active={index === active || undefined}
                onFocus={() => setCursor(index)}
                onClick={() => {
                  onSeek(line.timeMs)
                  // A click seeks and leaves the lyrics following the music.
                  setCursor(null)
                }}
                className={cn(
                  'block max-w-xl cursor-pointer rounded-md py-2 text-left text-2xl font-semibold leading-snug tracking-tight text-balance outline-none transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:text-3xl lg:leading-snug',
                  index === active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {line.text || '♪'}
              </div>
            ))}
          </div>
        )
        : <p className="max-w-xl whitespace-pre-line text-xl font-medium leading-relaxed">{lyrics.plain}</p>}
      <p className="mt-8 text-xs text-muted-foreground">Lyrics from {lyrics.source}</p>
    </div>
  )
}
