import { searchItemKey, tooShortToSearch, type MergedSearch, type SearchItem } from '@squirmy/client-core'
import type { AlbumSummary, ArtistSummary, TrackSummary } from '@squirmy/contracts'
import { ArrowRight, CornerDownLeft, Play, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { searchItemText, searchRowClass } from '@/components/music/search-row'
import { SearchItemArt, SearchRowBody } from '@/components/music/SearchRow'
import { Dialog, DialogFrame, DialogTitle } from '@/components/ui/dialog'
import { Kbd, Spinner } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'

const MAX_QUERY_LENGTH = 200

/** A place the dialog offers before anything is typed. */
export type SearchDestination = { label: string; to: string; icon: LucideIcon }

export type SearchChoice =
  | { kind: 'result'; item: SearchItem }
  | { kind: 'destination'; destination: SearchDestination }
  /** Every result for the query, on the search page. */
  | { kind: 'all'; query: string }

type SearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  /** The library's and the catalog's answers, merged. Null with no query or no answer yet. */
  results: MergedSearch | null
  /** The results answer the start of what is typed; the answer for all of it is on its way. */
  stale?: boolean
  loading: boolean
  /** Neither search could be made: the dialog says so and offers to try again. */
  failed?: boolean
  /** The catalog could not be searched: the results are the server's own music alone, and the dialog says so. */
  catalogFailed?: boolean
  onRetry?: () => void
  destinations: SearchDestination[]
  /** Whether a song plays when chosen (otherwise its album opens); and which artists and albums show dimmed. */
  canPlay: (track: TrackSummary) => boolean
  isDimmed: (item: { type: 'artist'; artist: ArtistSummary } | { type: 'album'; album: AlbumSummary }) => boolean
  onChoose: (choice: SearchChoice) => void
  /** The row the highlight rests on, chosen on purpose or as the best match: its page can start loading. */
  onIntent?: (choice: SearchChoice) => void
}

const choiceKey = (choice: SearchChoice) => (
  choice.kind === 'result' ? searchItemKey(choice.item)
    : choice.kind === 'destination' ? `to:${choice.destination.to}`
      : 'all'
)

/** How many results the dialog lists; the search page has the rest. */
export const DIALOG_RESULTS = 10

/** The results as the search page ranks them, all kinds mixed, best first. */
function choicesOf(results: MergedSearch | null): SearchChoice[] {
  return (results?.items ?? []).slice(0, DIALOG_RESULTS).map(item => ({ kind: 'result', item }))
}

/**
 * Quick search from anywhere: type, move with the arrow keys, Enter opens an artist or an album
 * and plays a song. With nothing typed it lists places to go. The search page has everything else.
 */
export function SearchDialog({ open, onOpenChange, query, onQueryChange, results, stale = false, loading, failed = false, catalogFailed = false, onRetry, destinations, canPlay, isDimmed, onChoose, onIntent }: SearchDialogProps) {
  const listboxId = useId()
  // The row the arrow keys or the pointer picked since the last change, by key: rows the catalog
  // adds later must not move the highlight off it. Until one is picked, Enter takes the best match.
  const [picked, setPicked] = useState<string | null>(null)
  const term = query.trim()
  const choices = useMemo<SearchChoice[]>(() => (
    term
      ? [...choicesOf(results), { kind: 'all', query: term }]
      : destinations.map(destination => ({ kind: 'destination', destination }))
  ), [term, results, destinations])
  const pickedIndex = picked === null ? -1 : choices.findIndex(choice => choiceKey(choice) === picked)
  const moved = pickedIndex >= 0
  // Results still showing for the start of the query are not what Enter should open: it searches
  // for what was typed, unless a row was picked on purpose.
  const active = moved ? pickedIndex : stale ? choices.length - 1 : 0
  const pick = (index: number) => {
    const choice = choices[index]
    if (choice) setPicked(choiceKey(choice))
  }
  const optionId = (index: number) => `${listboxId}-option-${index}`
  const settledEmpty = Boolean(term) && !stale && !loading && results !== null && choices.length === 1

  // Focus stays in the field, so the active option is scrolled into view as the arrow keys move it.
  useEffect(() => {
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listboxId])

  const intended = stale && !moved ? undefined : choices[active]
  useEffect(() => {
    if (intended) onIntent?.(intended)
  }, [intended, onIntent])

  const choose = (index: number) => {
    const choice = choices[index]
    if (choice) onChoose(choice)
  }
  const option = (choice: SearchChoice, index: number) => (
    <Option
      key={choiceKey(choice)}
      id={optionId(index)}
      choice={choice}
      active={index === active}
      stale={stale && choice.kind !== 'all'}
      plays={choice.kind === 'result' && choice.item.type === 'track' && canPlay(choice.item.track)}
      dimmed={choice.kind === 'result' && (choice.item.type === 'track' ? !canPlay(choice.item.track)
        : choice.item.type === 'artist' || choice.item.type === 'album' ? isDimmed(choice.item) : false)}
      onHover={() => pick(index)}
      onChoose={() => choose(index)}
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogFrame showClose={false} className="top-[18%] flex max-h-[min(34rem,calc(82dvh-1rem))] translate-y-0 flex-col overflow-hidden sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* The field has no box of its own, so focus shows as a line in the focus color under it. */}
        <div className="flex items-center gap-2.5 border-b px-4 has-[input:focus-visible]:shadow-[inset_0_-2px_0_var(--ring)]">
          {loading ? <Spinner className="size-4" label="Searching" /> : <Search aria-hidden className="size-4 text-muted-foreground" />}
          <input
            autoFocus
            role="combobox"
            aria-label="Search"
            aria-autocomplete="list"
            aria-expanded={choices.length > 0}
            aria-controls={choices.length > 0 ? listboxId : undefined}
            aria-activedescendant={choices[active] ? optionId(active) : undefined}
            value={query}
            onChange={event => {
              onQueryChange(event.target.value.slice(0, MAX_QUERY_LENGTH))
              setPicked(null)
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                pick(Math.min(active + 1, choices.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                pick(Math.max(active - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                choose(active)
              }
            }}
            placeholder="Songs, albums, artists"
            autoComplete="off"
            spellCheck={false}
            // 16px on phones: iOS zooms into any smaller field that gets focus.
            className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          {/* Phones have no Escape key. */}
          <Kbd aria-hidden className="max-md:hidden">esc</Kbd>
        </div>
        {(term ? settledEmpty || failed || catalogFailed : true) && (
          <div className="shrink-0 px-1.5 pt-1.5">
            {!term && <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Go to</p>}
            {term && failed && <Notice text="Search didn’t work. Check your connection." onRetry={onRetry} />}
            {/* Said whatever the server had: without the catalog, "No results" would say there is nothing to find. */}
            {term && !failed && catalogFailed && <Notice text="Couldn’t search the catalog. Only music on this server is listed." onRetry={onRetry} />}
            {/* A long unbroken query wraps rather than widening the dialog. */}
            {settledEmpty && !failed && (
              <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {tooShortToSearch(term) ? 'Keep typing to search.' : catalogFailed ? `Nothing on this server matches “${term}”.` : `No results for “${term}”.`}
              </p>
            )}
          </div>
        )}
        {/* The results scroll; the way to all of them stays in sight below them, however many there are. */}
        <div id={listboxId} role="listbox" aria-label={term ? 'Results' : 'Go to'} className="flex min-h-0 flex-col">
          <div className="min-h-0 overflow-y-auto p-1.5 empty:hidden">
            {choices.map((choice, index) => choice.kind !== 'all' && option(choice, index))}
          </div>
          {choices.map((choice, index) => choice.kind === 'all' && <div key="all" className="shrink-0 border-t p-1.5">{option(choice, index)}</div>)}
        </div>
      </DialogFrame>
    </Dialog>
  )
}

/** A failure above the results, with its retry: a status the field's user hears without leaving it. */
function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-2 px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">
      {text}
      {onRetry && <button type="button" onClick={onRetry} className="font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline">Try again</button>}
    </p>
  )
}

type OptionProps = { id: string; choice: SearchChoice; active: boolean; stale: boolean; plays: boolean; dimmed: boolean; onHover: () => void; onChoose: () => void }

function Option({ id, choice, active, stale, plays, dimmed, onHover, onChoose }: OptionProps) {
  const icon = (Icon: LucideIcon) => <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground"><Icon aria-hidden className="size-4" /></span>
  const body = choice.kind === 'result'
    ? <SearchRowBody art={<SearchItemArt item={choice.item} dimmed={dimmed} className="size-9" />} {...searchItemText(choice.item)} dimmed={dimmed} />
    : choice.kind === 'destination'
      ? <SearchRowBody strong={false} art={icon(choice.destination.icon)} title={choice.destination.label} />
      : <SearchRowBody strong={false} art={icon(Search)} title={`See all results for “${choice.query}”`} />
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onChoose}
      className={cn(searchRowClass(active, stale), 'py-1.5')}
    >
      {body}
      {active && (
        <span aria-hidden className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {plays ? <><Play className="size-3" fill="currentColor" />Play</> : choice.kind === 'all' ? <ArrowRight className="size-3.5" /> : 'Open'}
          <CornerDownLeft className="size-3" />
        </span>
      )}
    </button>
  )
}
