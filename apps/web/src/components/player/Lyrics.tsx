import type { Lyrics, LyricWord } from '@squirmy/contracts'
import { MessageSquareQuote } from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { LoadError } from '@/components/ui/query-state'
import { activeLine, lineLook, resumeFollowMs, syncedLines, wordProgress } from '@/lib/lyrics'
import { scrollBehavior } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { PlayerContext, PositionContext, usePosition, type LyricsStatus } from '@/player/player-context'
import './lyrics.css'

type LyricsPaneProps = {
  lyrics: Lyrics | null
  onSeek: (ms: number) => void
  /** Where the lyrics are; the player's by default. Without either, lyrics are there or there are none. */
  status?: LyricsStatus
  onRetry?: () => void
}

/**
 * The sung line's words, lit as they are sung: a word fills with the text's color from its start
 * to its end, over the dim color of the words to come. The clock's frames set one CSS variable on
 * the word being sung (`--sung`, 0 to 1) and nothing re-renders; only that word is painted again.
 * Under reduced motion a word lights whole as it starts.
 */
function SungWords({ words }: { words: readonly LyricWord[] }) {
  const clock = useContext(PositionContext)
  const spans = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    const stepped = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const shown: (string | null)[] = []
    const paint = () => {
      const { index, fraction } = wordProgress(words, clock.get())
      for (const [i, span] of spans.current.entries()) {
        const value = i < index ? '1' : i > index ? '0' : stepped ? '1' : fraction.toFixed(3)
        if (!span || shown[i] === value) continue
        shown[i] = value
        span.style.setProperty('--sung', value)
      }
    }
    paint()
    return clock.subscribe(paint)
  }, [clock, words])
  return <span className="lyric-words">
    {words.map((word, index) => <span key={index} ref={element => { spans.current[index] = element }} className="lyric-word">{word.text}</span>)}
  </span>
}

/**
 * Synced lyrics follow the clock and seek on click; plain lyrics just scroll. As in the iOS app,
 * the sung line is bright and sharp and the others dim and blur more the farther they are, while
 * the list follows the song. A reader who scrolls by hand sees every line sharp, and a few
 * seconds after they stop the list goes back to the sung line. Reduced motion or transparency
 * keeps the dimming and drops the blur, and the line under the pointer or the keyboard is sharp. Lyrics with
 * word times light the sung line word by word (`SungWords`), and a line's translation is under it. Synced lines are
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
  const lines = useMemo(() => syncedLines(lyrics), [lyrics])
  const active = usePosition(position => activeLine(lines, position))
  const container = useRef<HTMLDivElement>(null)
  // The line the keyboard is on while it is in the list; out of it, Tab comes back to the line playing.
  const [cursor, setCursor] = useState<number | null>(null)
  const tabStop = cursor ?? Math.max(0, active)
  const lineRefs = useRef<(HTMLElement | null)[]>([])
  // Scrolling by hand: the lines are all sharp, and the list stops following until it rests a while.
  const [scrolling, setScrolling] = useState(false)
  const resume = useRef<number | undefined>(undefined)
  const browsing = scrolling || cursor !== null
  const onReaderScroll = () => {
    setScrolling(true)
    window.clearTimeout(resume.current)
    resume.current = window.setTimeout(() => setScrolling(false), resumeFollowMs)
  }
  useEffect(() => () => window.clearTimeout(resume.current), [])

  useEffect(() => {
    // While the keyboard moves through the lines, or a reader scrolls, the list stays where they put it.
    if (browsing) return
    container.current?.querySelector<HTMLElement>('[data-active]')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  }, [active, browsing])

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
      onSeek(lines[at]!.startMs)
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
    // The room above the first line and below the last is a share of the pane's own height, never of
    // the screen's: as padding, more than the pane could hold made it taller than its place, and the
    // lines ran on over the song's title and the controls under it on a phone.
    <div ref={container} onWheel={onReaderScroll} onTouchMove={onReaderScroll} className="scrollbar-none h-full overflow-y-auto px-1 before:block before:h-2/5 after:block after:h-2/5 [mask-image:linear-gradient(transparent,black_18%,black_82%,transparent)]">
      {lines.length
        ? (
          <div
            role="listbox"
            aria-label="Lyrics"
            onKeyDown={onKeyDown}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setCursor(null) }}
          >
            {lines.map((line, index) => {
              const look = lineLook(index - active, browsing)
              return <div
                key={`${line.startMs}-${index}`}
                ref={element => { lineRefs.current[index] = element }}
                role="option"
                tabIndex={index === tabStop ? 0 : -1}
                aria-selected={index === active}
                data-active={index === active || undefined}
                onFocus={() => setCursor(index)}
                onClick={() => {
                  onSeek(line.startMs)
                  // A click seeks and leaves the lyrics following the music.
                  setCursor(null)
                }}
                style={{ '--lyric-opacity': look.opacity, '--lyric-blur': `${look.blur}px` } as CSSProperties}
                className={cn(
                  'block max-w-xl cursor-pointer rounded-md py-2 text-left text-2xl font-semibold leading-snug tracking-tight text-balance text-foreground outline-none opacity-(--lyric-opacity) transition-[opacity,filter] duration-500 ease-out hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring lg:text-3xl lg:leading-snug',
                  // Only a blurred line gets a filter: a filter of nothing still costs a layer to draw.
                  look.blur > 0 && '[filter:blur(var(--lyric-blur))] hover:[filter:none] focus-visible:[filter:none] motion-reduce:[filter:none] [@media(prefers-reduced-transparency:reduce)]:[filter:none]',
                )}
              >
                {index === active && line.words?.length ? <SungWords words={line.words} /> : line.text || '♪'}
                {line.translation && <span className="mt-1 block text-lg font-medium leading-snug tracking-normal text-muted-foreground lg:text-xl">{line.translation}</span>}
              </div>
            })}
          </div>
        )
        : <p className="max-w-xl whitespace-pre-line text-xl font-medium leading-relaxed">{lyrics.plain}</p>}
      <p className="mt-8 text-xs text-muted-foreground">Lyrics from {lyrics.source}</p>
    </div>
  )
}
