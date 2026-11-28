import { searchItemKey, tooShortToSearch, type MergedSearch, type SearchItem } from '@squirmy/client-core'
import type { AlbumSummary, ArtistSummary, TrackSummary } from '@squirmy/contracts'
import { ArrowRight, CornerDownLeft, Play, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { searchItemText, searchRowClass } from '@/components/music/search-row'
import { SearchItemArt, SearchRowBody } from '@/components/music/SearchRow'
import { Dialog, DialogFrame, DialogTitle } from '@/components/ui/dialog'
import { Kbd, Spinner } from '@/components/ui/feedback'
import { fuzzyFilter } from '@/lib/fuzzy'
import { cn } from '@/lib/utils'

const MAX_QUERY_LENGTH = 200

/** A place the dialog offers before anything is typed. */
export type SearchDestination = { label: string; to: string; icon: LucideIcon }

/**
 * Something the dialog does rather than finds: play or pause, show the queue, open a setting.
 * `keywords` are other words it answers to; `shortcut` is its key, shown beside it.
 */
export type PaletteCommand = { id: string; label: string; icon: LucideIcon; keywords?: string[]; shortcut?: string; disabled?: boolean; run: () => void }

export type SearchChoice =
  | { kind: 'result'; item: SearchItem }
  | { kind: 'destination'; destination: SearchDestination }
  | { kind: 'command'; command: PaletteCommand }
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
  /**
   * What the dialog can do: listed under the places to go before anything is typed, and the
   * best few matches after the results as it is. A query that starts with ">" lists commands alone.
   */
  commands?: PaletteCommand[]
}

const choiceKey = (choice: SearchChoice) => (
  choice.kind === 'result' ? searchItemKey(choice.item)
    : choice.kind === 'destination' ? `to:${choice.destination.to}`
      : choice.kind === 'command' ? `do:${choice.command.id}`
        : 'all'
)

/** How many commands and places follow the results of a query. */
const MATCHED_COMMANDS = 4
/** Starts a query for commands alone, as in code editors' palettes. */
const COMMAND_PREFIX = '>'

const noCommands: PaletteCommand[] = []

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
export function SearchDialog({ open, onOpenChange, query, onQueryChange, results, stale: staleResults = false, loading: searching, failed: searchFailed = false, catalogFailed: catalogMissing = false, onRetry, destinations, canPlay, isDimmed, onChoose, onIntent, commands = noCommands }: SearchDialogProps) {
  const listboxId = useId()
  // The row the arrow keys or the pointer picked since the last change, by key: rows the catalog
  // adds later must not move the highlight off it. Until one is picked, Enter takes the best match.
  const [picked, setPicked] = useState<string | null>(null)
  const typed = query.trim()
  const commandsOnly = typed.startsWith(COMMAND_PREFIX)
  // A query for commands searches nothing: the rest of this dialog reads as if nothing were typed but the commands.
  const term = commandsOnly ? '' : typed
  const stale = !commandsOnly && staleResults
  const loading = !commandsOnly && searching
  const failed = !commandsOnly && searchFailed
  const catalogFailed = !commandsOnly && catalogMissing
  const commandTerm = commandsOnly ? typed.slice(COMMAND_PREFIX.length).trim() : typed
  const matched = useMemo<SearchChoice[]>(() => {
    const all: SearchChoice[] = [
      ...commands.filter(command => !command.disabled).map(command => ({ kind: 'command' as const, command })),
      ...(commandsOnly ? [] : destinations.map(destination => ({ kind: 'destination' as const, destination }))),
    ]
    return fuzzyFilter(all, commandTerm, choice => (choice.kind === 'command' ? [choice.command.label, ...(choice.command.keywords ?? [])] : choice.kind === 'destination' ? [choice.destination.label] : []))
  }, [commands, destinations, commandTerm, commandsOnly])
  const choices = useMemo<SearchChoice[]>(() => (
    commandsOnly ? matched
      : term
        // One letter finds music; commands and places from two, so they are what was meant.
        ? [...choicesOf(results), ...(commandTerm.length > 1 ? matched.slice(0, MATCHED_COMMANDS) : []), { kind: 'all', query: term }]
        : [...destinations.map(destination => ({ kind: 'destination' as const, destination })), ...commands.filter(command => !command.disabled).map(command => ({ kind: 'command' as const, command }))]
  ), [commandsOnly, matched, term, commandTerm, results, destinations, commands])
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
  const settledEmpty = Boolean(term) && !stale && !loading && results !== null && choices.every(choice => choice.kind !== 'result')

  // Focus stays in the field, so the active option is scrolled into view as the arrow keys move it.
  useEffect(() => {
    document.getElementById(`${listboxId}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listboxId])

  const intended = stale && !moved ? undefined : choices[active]
  useEffect(() => {
    if (intended) onIntent?.(intended)
  }, [intended, onIntent])

  // Before anything is typed the places lead, listed alone; commands follow under their heading.
  const grouped = (choice: SearchChoice) => !commandsOnly && (choice.kind === 'command' || (Boolean(term) && choice.kind === 'destination'))
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
      stale={stale && choice.kind === 'result'}
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
            placeholder={commands.length ? 'Songs, albums, artists or commands' : 'Songs, albums, artists'}
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
            {!term && <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{commandsOnly ? 'Commands' : 'Go to'}</p>}
            {commandsOnly && !choices.length && <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">No command matches “{commandTerm}”.</p>}
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
        <div id={listboxId} role="listbox" aria-label={commandsOnly ? 'Commands' : term ? 'Results' : 'Go to'} className="flex min-h-0 flex-col">
          <div className="min-h-0 overflow-y-auto p-1.5 empty:hidden">
            {choices.map((choice, index) => choice.kind !== 'all' && !grouped(choice) && option(choice, index))}
            {/* The commands (and, as something is typed, the places) under a heading of their own, after the music. */}
            {!commandsOnly && choices.some(grouped) && (
              <div role="group" aria-labelledby={`${listboxId}-commands`}>
                <p id={`${listboxId}-commands`} className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{term ? 'Commands and places' : 'Commands'}</p>
                {choices.map((choice, index) => grouped(choice) && option(choice, index))}
              </div>
            )}
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
      : choice.kind === 'command'
        ? <SearchRowBody strong={false} art={icon(choice.command.icon)} title={choice.command.label} />
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
      {active ? (
        <span aria-hidden className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {plays ? <><Play className="size-3" fill="currentColor" />Play</> : choice.kind === 'all' ? <ArrowRight className="size-3.5" /> : choice.kind === 'command' ? 'Run' : 'Open'}
          <CornerDownLeft className="size-3" />
        </span>
      ) : choice.kind === 'command' && choice.command.shortcut && <Kbd aria-hidden className="shrink-0 max-md:hidden">{choice.command.shortcut}</Kbd>}
    </button>
  )
}
