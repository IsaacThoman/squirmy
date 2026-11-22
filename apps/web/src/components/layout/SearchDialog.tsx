import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts'
import { ArrowRight, CornerDownLeft, Play, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Monogram } from '@/components/music/Cards'
import { Cover } from '@/components/music/Cover'
import { Dialog, DialogFrame, DialogTitle } from '@/components/ui/dialog'
import { Kbd, Spinner } from '@/components/ui/feedback'
import { albumTypeLabel } from '@/lib/catalog'
import { cn } from '@/lib/utils'

const MAX_QUERY_LENGTH = 200

/** A place the dialog offers before anything is typed. */
export type SearchDestination = { label: string; to: string; icon: LucideIcon }

export type SearchChoice =
  | { kind: 'artist'; artist: ArtistSummary }
  | { kind: 'album'; album: AlbumSummary }
  | { kind: 'track'; track: TrackSummary }
  | { kind: 'destination'; destination: SearchDestination }
  /** Every result for the query, on the search page. */
  | { kind: 'all'; query: string }

type SearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  /** The library's answer for the query. Null with no query or no answer yet. */
  results: SearchResults | null
  loading: boolean
  destinations: SearchDestination[]
  /** Whether a song plays when chosen; otherwise its album opens. */
  canPlay: (track: TrackSummary) => boolean
  onChoose: (choice: SearchChoice) => void
}

const choiceKey = (choice: SearchChoice) => (
  choice.kind === 'artist' ? `artist:${choice.artist.id}`
    : choice.kind === 'album' ? `album:${choice.album.id}`
      : choice.kind === 'track' ? `track:${choice.track.id}`
        : choice.kind === 'destination' ? `to:${choice.destination.to}`
          : 'all'
)

/** The library's results as one list, its best match first. */
function choicesOf(results: SearchResults | null): SearchChoice[] {
  if (!results) return []
  const choices: SearchChoice[] = [
    ...results.artists.slice(0, 3).map(artist => ({ kind: 'artist' as const, artist })),
    ...results.albums.slice(0, 4).map(album => ({ kind: 'album' as const, album })),
    ...results.tracks.slice(0, 5).map(track => ({ kind: 'track' as const, track })),
  ]
  const top = results.top
  if (!top) return choices
  const index = choices.findIndex(choice => choiceKey(choice) === `${top.type}:${top.id}`)
  return index > 0 ? [choices[index], ...choices.slice(0, index), ...choices.slice(index + 1)] : choices
}

/**
 * Quick search from anywhere: type, move with the arrow keys, Enter opens an artist or an album
 * and plays a song. With nothing typed it lists places to go. The search page has everything else.
 */
export function SearchDialog({ open, onOpenChange, query, onQueryChange, results, loading, destinations, canPlay, onChoose }: SearchDialogProps) {
  const listboxId = useId()
  const [cursor, setCursor] = useState(0)
  const term = query.trim()
  const choices = useMemo<SearchChoice[]>(() => (
    term
      ? [...choicesOf(results), { kind: 'all', query: term }]
      : destinations.map(destination => ({ kind: 'destination', destination }))
  ), [term, results, destinations])
  const active = Math.min(cursor, Math.max(0, choices.length - 1))
  const optionId = (index: number) => `${listboxId}-option-${index}`

  // Focus stays in the field, so the active option is scrolled into view as the arrow keys move it.
  useEffect(() => {
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listboxId])

  const choose = (index: number) => {
    const choice = choices[index]
    if (choice) onChoose(choice)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogFrame showClose={false} className="top-[18%] flex max-h-[min(34rem,calc(82dvh-1rem))] translate-y-0 flex-col overflow-hidden sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2.5 border-b px-4">
          {loading ? <Spinner className="size-4" label="Searching" /> : <Search aria-hidden className="size-4 text-muted-foreground" />}
          <input
            autoFocus
            role="combobox"
            aria-label="Search your library"
            aria-autocomplete="list"
            aria-expanded={choices.length > 0}
            aria-controls={choices.length > 0 ? listboxId : undefined}
            aria-activedescendant={choices[active] ? optionId(active) : undefined}
            value={query}
            onChange={event => {
              onQueryChange(event.target.value.slice(0, MAX_QUERY_LENGTH))
              setCursor(0)
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor(Math.min(active + 1, choices.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor(Math.max(active - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(active)
              }
            }}
            placeholder="Songs, albums, artists"
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd aria-hidden>esc</Kbd>
        </div>
        <div className="min-h-0 overflow-y-auto p-1.5">
          {!term && <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Go to</p>}
          <div id={listboxId} role="listbox" aria-label={term ? 'Results' : 'Go to'}>
            {choices.map((choice, index) => (
              <Option
                key={choiceKey(choice)}
                id={optionId(index)}
                choice={choice}
                active={index === active}
                plays={choice.kind === 'track' && canPlay(choice.track)}
                onHover={() => setCursor(index)}
                onChoose={() => choose(index)}
              />
            ))}
          </div>
        </div>
      </DialogFrame>
    </Dialog>
  )
}

function Option({ id, choice, active, plays, onHover, onChoose }: { id: string; choice: SearchChoice; active: boolean; plays: boolean; onHover: () => void; onChoose: () => void }) {
  const { art, title, detail, dimmed }: { art: ReactNode; title: string; detail?: string; dimmed?: boolean } = (() => {
    switch (choice.kind) {
      case 'artist':
        return {
          art: choice.artist.image ? <Cover artwork={choice.artist.image} round size={96} className="size-9" /> : <Monogram name={choice.artist.name} className="size-9 text-sm" />,
          title: choice.artist.name,
          detail: 'Artist',
          dimmed: !choice.artist.inLibrary,
        }
      case 'album':
        return {
          art: <Cover artwork={choice.album.artwork} size={96} className="size-9 rounded-[5px]" />,
          title: choice.album.title,
          detail: `${albumTypeLabel(choice.album.type)} · ${choice.album.artistCredit}`,
        }
      case 'track':
        return {
          art: <Cover artwork={choice.track.album?.artwork ?? null} size={96} className="size-9 rounded-[5px]" />,
          title: choice.track.title,
          detail: `Song · ${choice.track.artistCredit}`,
          dimmed: !plays,
        }
      case 'destination': {
        const Icon = choice.destination.icon
        return { art: <span className="flex size-9 items-center justify-center text-muted-foreground"><Icon aria-hidden className="size-4" /></span>, title: choice.destination.label }
      }
      case 'all':
        return { art: <span className="flex size-9 items-center justify-center text-muted-foreground"><Search aria-hidden className="size-4" /></span>, title: `Search everything for “${choice.query}”`, detail: 'Your library and music you do not have yet' }
    }
  })()
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onChoose}
      className={cn('flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm outline-none', active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}
    >
      {art}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', choice.kind !== 'destination' && choice.kind !== 'all' && 'font-medium', dimmed && 'text-muted-foreground')}>{title}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {active && (
        <span aria-hidden className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {plays ? <><Play className="size-3" fill="currentColor" />Play</> : choice.kind === 'all' ? <ArrowRight className="size-3.5" /> : 'Open'}
          <CornerDownLeft className="size-3" />
        </span>
      )}
    </button>
  )
}
