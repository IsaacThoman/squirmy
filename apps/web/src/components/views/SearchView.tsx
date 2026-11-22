import { recentSearchKey, searchItemKey, tooShortToSearch, type RecentSearch, type SearchFilter, type SearchItem } from '@squirmy/client-core'
import type { TrackSummary } from '@squirmy/contracts'
import { Clock3, MoreHorizontal, Play, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { GenreTile } from '@/components/music/Cards'
import { Equalizer } from '@/components/music/Equalizer'
import { SaveHeart } from '@/components/music/LibrarySave'
import { PrefetchLink } from '@/components/music/PrefetchLink'
import { useResultMenus } from '@/components/music/result-menus'
import { searchItemText, searchRowClass } from '@/components/music/search-row'
import { SearchItemArt, SearchRowBody } from '@/components/music/SearchRow'
import { SectionHeader } from '@/components/music/SectionHeader'
import { trackMenuEntries } from '@/components/music/track-menu'
import { Button } from '@/components/ui/button'
import { EmptyState, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { SearchField } from '@/components/ui/search-field'
import { pillClass } from '@/components/ui/tabs'
import { albumPresentation, canFetch, genreColor, isPlayable, UNAVAILABLE_LABEL } from '@/lib/catalog'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { usePlayer } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

/** The results for what is typed and the filter chosen, however they were found. */
export type SearchList = {
  /** Null until an answer that may be shown has arrived. */
  items: SearchItem[] | null
  /** The items answer an earlier query or filter and stay, faded, while the new answer loads. */
  stale: boolean
  /** More results for what is typed are on their way (the catalog's, or the next page). */
  pending: boolean
  failed: boolean
  /** The catalog could not be searched; what is listed is the server's own music. */
  catalogFailed: boolean
  unavailable: boolean
  retry: () => void
  /** A filter's list goes on: called as its end comes into view. */
  loadMore?: () => void
  hasMore?: boolean
}

const filterLabels: Record<SearchFilter, string> = { all: 'All', track: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' }

type SearchViewProps = {
  query: string
  onQueryChange: (query: string) => void
  filter: SearchFilter
  onFilterChange: (filter: SearchFilter) => void
  list: SearchList
  recents: RecentSearch[]
  onRemoveRecent: (key: string) => void
  onClearRecents: () => void
  genres: string[]
  onBrowseGenre: (genre: string) => void
  /** Opens an artist, album or playlist; plays a song (with the songs listed after it), or opens the album of one that does not play. */
  onChoose: (item: SearchItem, list: readonly SearchItem[]) => void
  onSearchRecent: (query: string) => void
}

/** How many recent searches and recently viewed results the page offers. */
const RECENT_QUERIES = 6
const RECENT_ITEMS = 10

type Choice = { key: string; choose: () => void }

/**
 * One list of results for what is typed, every kind mixed and ranked by the server, with
 * chips that narrow it to one kind and page further. Music on the server and music it can
 * fetch look the same; what does not play is gray. The arrow keys move through the rows
 * from the field and Enter opens or plays the one highlighted, else the best match. With
 * nothing typed it offers recent searches, recently viewed results and genres.
 */
export function SearchView(props: SearchViewProps) {
  const { query, onQueryChange, filter, onFilterChange, list, recents, onRemoveRecent, onClearRecents, genres, onBrowseGenre, onChoose, onSearchRecent } = props
  const term = query.trim()
  const listboxId = useId()
  const recentQueries = useMemo(() => recents.filter(entry => entry.type === 'query').slice(0, RECENT_QUERIES), [recents])
  const recentItems = useMemo(() => recents.filter((entry): entry is Exclude<RecentSearch, { type: 'query' }> => entry.type !== 'query').slice(0, RECENT_ITEMS), [recents])

  // What the arrow keys move through: the results, or with nothing typed the recent searches and results.
  const choices = useMemo<Choice[]>(() => {
    if (term) return (list.items ?? []).map(item => ({ key: searchItemKey(item), choose: () => onChoose(item, list.items ?? []) }))
    return [
      ...recentQueries.map(entry => ({ key: recentSearchKey(entry), choose: () => onSearchRecent(entry.type === 'query' ? entry.query : '') })),
      ...recentItems.map(entry => ({ key: recentSearchKey(entry), choose: () => onChoose(entry, [entry]) })),
    ]
  }, [term, list.items, recentQueries, recentItems, onChoose, onSearchRecent])
  // The row picked with the arrow keys, by key, so rows that arrive later do not move it.
  const [picked, setPicked] = useState<string | null>(null)
  const pickedIndex = picked === null ? -1 : choices.findIndex(choice => choice.key === picked)
  const optionId = (key: string) => `${listboxId}-${key}`
  useEffect(() => {
    if (picked) document.getElementById(optionId(picked))?.scrollIntoView({ block: 'nearest' })
    // The id is derived from the key.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [picked])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!choices.length) return
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? Math.min(pickedIndex + 1, choices.length - 1) : Math.max(pickedIndex - 1, 0)
      setPicked(choices[next]!.key)
    } else if (event.key === 'Enter') {
      // Results of an earlier query are not what Enter should open.
      const choice = pickedIndex >= 0 ? choices[pickedIndex] : term && !list.stale ? choices[0] : undefined
      if (!choice) return
      event.preventDefault()
      choice.choose()
    }
  }
  const changeQuery = (next: string) => {
    setPicked(null)
    onQueryChange(next)
  }

  return (
    <>
      {/* The field follows the title and takes the room there is, instead of sitting at the far end like a page's controls. */}
      <PageHeader title="Search" controls="fill">
        <SearchField
          value={query}
          onValueChange={changeQuery}
          onKeyDown={onKeyDown}
          aria-label="Search"
          placeholder="Songs, albums, artists, playlists"
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={choices.length > 0}
          aria-controls={choices.length > 0 ? listboxId : undefined}
          aria-activedescendant={picked && pickedIndex >= 0 ? optionId(picked) : undefined}
          className="w-full max-w-md"
        />
      </PageHeader>
      <Page className="flex flex-col gap-6">
        {term ? (
          <>
            <Filters value={filter} onChange={next => { setPicked(null); onFilterChange(next) }} />
            <Results term={term} filter={filter} list={list} listboxId={listboxId} optionId={optionId} picked={picked} onChoose={onChoose} />
          </>
        ) : (
          <>
            {(recentQueries.length > 0 || recentItems.length > 0) && (
              <Recents
                queries={recentQueries}
                items={recentItems}
                listboxId={listboxId}
                optionId={optionId}
                picked={picked}
                onSearch={onSearchRecent}
                onChoose={item => onChoose(item, [item])}
                onRemove={onRemoveRecent}
                onClear={onClearRecents}
              />
            )}
            {genres.length > 0 && (
              <section>
                <SectionHeader title="Browse by genre" />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {genres.map(genre => <GenreTile key={genre} name={genre} color={genreColor(genre)} onClick={() => onBrowseGenre(genre)} />)}
                </div>
              </section>
            )}
          </>
        )}
      </Page>
    </>
  )
}

function Filters({ value, onChange }: { value: SearchFilter; onChange: (filter: SearchFilter) => void }) {
  return (
    <div role="group" aria-label="Show" className="scrollbar-none -mx-1 -my-1 flex gap-1.5 overflow-x-auto px-1 py-1">
      {(Object.keys(filterLabels) as SearchFilter[]).map(filter => (
        <button
          key={filter}
          type="button"
          aria-pressed={filter === value}
          data-state={filter === value ? 'active' : undefined}
          onClick={() => onChange(filter)}
          className={cn(pillClass, 'rounded-full border px-3.5 data-[state=active]:border-transparent')}
        >
          {filterLabels[filter]}
        </button>
      ))}
    </div>
  )
}

type ResultsProps = {
  term: string
  filter: SearchFilter
  list: SearchList
  listboxId: string
  optionId: (key: string) => string
  picked: string | null
  onChoose: (item: SearchItem, list: readonly SearchItem[]) => void
}

function Results({ term, filter, list, listboxId, optionId, picked, onChoose }: ResultsProps) {
  const { items, stale, pending, failed, catalogFailed, unavailable, retry, loadMore, hasMore } = list
  const tracks = useMemo(() => (items ?? []).flatMap(item => (item.type === 'track' ? [item.track] : [])), [items])
  const actions = useTrackActions(tracks)
  const resultMenu = useResultMenus()
  const viewer = useViewer()
  const navigate = useNavigate()

  if (unavailable) return <EmptyState icon={<Search />} title="Search is not available yet" description="This server does not answer searches yet. Browse your library in the meantime." />
  if (failed) {
    return (
      <EmptyState
        icon={<Search />}
        title="Search didn’t work"
        description="The server could not be reached. Check your connection and try again."
        action={<Button variant="secondary" onClick={retry}><RotateCw />Try again</Button>}
      />
    )
  }
  if (tooShortToSearch(term) && filter !== 'playlist') return <p className="text-sm text-muted-foreground">Keep typing: search needs at least two letters or digits.</p>
  if (!items) return <ResultsSkeleton />
  if (!items.length && !pending && !stale) {
    return (
      <EmptyState
        icon={<Search />}
        title={`No ${filter === 'all' ? 'results' : filterLabels[filter].toLowerCase()} for “${term}”`}
        description={filter === 'all' ? 'Check the spelling, or try an artist, album or song name.' : 'Try All, or another spelling.'}
      />
    )
  }
  return (
    // A row reads across: past this width its duration and menu drift away from its title.
    <div aria-busy={stale || pending || undefined} className="max-w-4xl">
      {catalogFailed && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          Only music on this server is listed: the catalog could not be searched.
          <button type="button" onClick={retry} className="font-medium text-foreground underline-offset-4 hover:underline">Try again</button>
        </p>
      )}
      <ol id={listboxId} role="listbox" aria-label={`Results for ${term}`} className="-mx-2.5 flex flex-col">
        {items.map(item => {
          const key = searchItemKey(item)
          return (
            <ResultRow
              key={key}
              id={optionId(key)}
              item={item}
              active={picked === key}
              stale={stale}
              onChoose={() => onChoose(item, items)}
              trackMenu={item.type === 'track' ? track => trackMenuEntries(track, {
                unavailable: !isPlayable(track, viewer),
                wanted: actions.isWanted?.(track),
                playlists: actions.playlists,
                act: action => actions.onAction(action, track, tracks.indexOf(track)),
                navigate: to => void navigate(to),
              }) : undefined}
              resultMenu={resultMenu}
              onLike={item.type === 'track' ? () => actions.onAction('like', item.track, tracks.indexOf(item.track)) : undefined}
            />
          )
        })}
      </ol>
      {(pending || hasMore) && <MoreResults loading={pending} onEndReached={hasMore ? loadMore : undefined} />}
    </div>
  )
}

type ResultRowProps = {
  id: string
  item: SearchItem
  active: boolean
  stale: boolean
  onChoose: () => void
  trackMenu?: (track: TrackSummary) => MenuEntry[]
  resultMenu: ReturnType<typeof useResultMenus>
  onLike?: () => void
}

/**
 * One result: its artwork, its name and "Kind · Artist". The row opens an artist, album or
 * playlist and plays a song; a song that does not play is gray and opens its album. Its
 * menu (the overflow button, or a right click) is the one the same kind has everywhere.
 */
function ResultRow({ id, item, active, stale, onChoose, trackMenu, resultMenu, onLike }: ResultRowProps) {
  const viewer = useViewer()
  const { state, controls } = usePlayer()
  const { title, detail } = searchItemText(item)
  const track = item.type === 'track' ? item.track : null
  const unavailable = track ? !isPlayable(track, viewer) : false
  const dimmed = item.type === 'album' ? albumPresentation(item.album, viewer) === 'dimmed'
    : item.type === 'artist' ? !item.artist.inLibrary && !canFetch(viewer) : unavailable
  const current = track !== null && state.current?.track.id === track.id
  const playing = current && state.playing
  const loading = current && state.waiting
  const menu = track ? trackMenu!(track) : resultMenu(item as Exclude<SearchItem, { type: 'track' }>)

  const overlay = 'absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring'
  // A plain click goes through `onChoose`, which records the result as recently viewed and
  // navigates; one that opens a new tab is left to the browser.
  const onLinkClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onChoose()
  }
  const primary = item.type === 'track'
    ? (
      <button
        type="button"
        aria-label={unavailable ? `${title}, ${UNAVAILABLE_LABEL}` : playing ? `Pause ${title}` : `Play ${title}`}
        onClick={current && !unavailable ? controls.togglePlay : onChoose}
        className={overlay}
      />
    )
    : item.type === 'playlist'
      ? <Link to={`/playlist/${item.playlist.id}`} aria-label={`${title}, ${detail}`} onClick={onLinkClick} className={overlay} />
      : (
        <PrefetchLink
          kind={item.type}
          id={item.type === 'artist' ? item.artist.id : item.album.id}
          to={item.type === 'artist' ? `/artist/${item.artist.id}` : `/album/${item.album.id}`}
          aria-label={`${title}, ${detail}`}
          onClick={onLinkClick}
          className={overlay}
        />
      )

  return (
    <ContextMenu entries={menu}>
      <li
        id={id}
        role="option"
        aria-selected={active}
        // Not disabled: a song that does not play still opens its album, and its heart and menu work.
        // Its button's name says "Not available".
        title={unavailable ? UNAVAILABLE_LABEL : undefined}
        className={cn('group/row relative h-14', searchRowClass(active, stale))}
      >
        <div className="relative size-10 shrink-0">
          <SearchItemArt item={item} dimmed={dimmed} className="size-10" />
          {track && !unavailable && (
            // Over a song's cover: the playing marker, the buffering spinner, or a play button on hover.
            <div aria-hidden className={cn('absolute inset-0 flex items-center justify-center rounded-[5px] text-white transition-colors', current ? 'bg-black/50' : 'opacity-0 group-hover/row:bg-black/50 group-hover/row:opacity-100')}>
              {loading ? <Spinner label={null} className="size-4 text-white" />
                : current ? (playing ? <Equalizer playing className="text-white" /> : <Play className="size-3.5" fill="currentColor" />)
                  : <Play className="size-3.5" fill="currentColor" />}
            </div>
          )}
        </div>
        <SearchRowBody art={null} title={title} detail={detail} dimmed={dimmed} current={current} explicit={track?.explicit ?? false} note={unavailable ? UNAVAILABLE_LABEL : undefined} />
        {primary}
        {/* A finger gets 44 px for the heart and the menu, with no gap between them. */}
        <div className="relative z-10 flex shrink-0 items-center gap-1 pointer-coarse:gap-0">
          {track && onLike && (
            <SaveHeart liked={track.liked} onToggle={onLike} title={title} tooltip={false} size="sm" className={cn('pointer-coarse:size-11', !track.liked && revealed)} />
          )}
          {track && <span className={cn('hidden w-10 text-right text-xs tabular sm:block', unavailable ? 'text-faded-foreground' : 'text-muted-foreground')}>{track.durationMs ? formatDuration(track.durationMs) : '–'}</span>}
          <DropdownMenu
            entries={menu}
            trigger={<IconButton label={`More options for ${title}`} tooltip={false} size="sm" className={cn('pointer-coarse:size-11', revealed)}><MoreHorizontal /></IconButton>}
          />
        </div>
      </li>
    </ContextMenu>
  )
}

/** Controls that show when their row is hovered, holds the keyboard's focus or has its menu open; always on touch screens. */
const revealed = 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/row:opacity-100 md:pointer-fine:group-has-[:focus-visible]/row:opacity-100 md:pointer-fine:group-has-[[data-state=open]]/row:opacity-100 md:pointer-fine:group-aria-selected/row:opacity-100'

/** The end of a list: a spinner while more is on its way, and the next page loading as it comes into view. */
function MoreResults({ loading, onEndReached }: { loading: boolean; onEndReached?: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = sentinel.current
    // Without an observer (an old browser) the button below loads the next page.
    if (!element || !onEndReached || loading || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onEndReached()
    }, { rootMargin: '400px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onEndReached, loading])
  return (
    <div ref={sentinel} className="flex h-14 items-center justify-center gap-2 text-sm text-muted-foreground">
      {loading ? <><Spinner label={null} className="size-4" />Searching for more…</>
        : onEndReached && <Button variant="ghost" size="sm" onClick={onEndReached}>Show more</Button>}
    </div>
  )
}

type RecentsProps = {
  queries: Extract<RecentSearch, { type: 'query' }>[]
  items: Exclude<RecentSearch, { type: 'query' }>[]
  listboxId: string
  optionId: (key: string) => string
  picked: string | null
  onSearch: (query: string) => void
  onChoose: (item: SearchItem) => void
  onRemove: (key: string) => void
  onClear: () => void
}

/** Recent searches and recently viewed results, each removable, with one button that clears them all. */
function Recents({ queries, items, listboxId, optionId, picked, onSearch, onChoose, onRemove, onClear }: RecentsProps) {
  const viewer = useViewer()
  const row = (entry: RecentSearch, body: ReactNode, onSelect: () => void, label: string) => {
    const key = recentSearchKey(entry)
    return (
      <li key={key} id={optionId(key)} role="option" aria-selected={picked === key} className={cn('group/row relative h-12', searchRowClass(picked === key, false))}>
        {body}
        <button type="button" aria-label={label} onClick={onSelect} className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <IconButton label={`Remove ${label} from recent searches`} tooltip={false} size="sm" onClick={() => onRemove(key)} className={cn('relative z-10', revealed)}>
          <X />
        </IconButton>
      </li>
    )
  }
  return (
    <section aria-labelledby="search-recent" className="max-w-4xl">
      <SectionHeader id="search-recent" title="Recent searches" action={<Button variant="ghost" size="sm" onClick={onClear}>Clear all</Button>} />
      <ol id={listboxId} role="listbox" aria-label="Recent searches" className="-mx-2.5 flex flex-col">
        {queries.map(entry => row(
          entry,
          <SearchRowBody strong={false} art={<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Clock3 aria-hidden className="size-4" /></span>} title={entry.query} />,
          () => onSearch(entry.query),
          entry.query,
        ))}
        {items.length > 0 && <li role="presentation" className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recently viewed</li>}
        {items.map(entry => {
          const { title, detail } = searchItemText(entry)
          const dimmed = entry.type === 'track' ? !isPlayable(entry.track, viewer) : entry.type === 'album' ? albumPresentation(entry.album, viewer) === 'dimmed' : false
          return row(entry, <SearchRowBody art={<SearchItemArt item={entry} dimmed={dimmed} className="size-9" />} title={title} detail={detail} dimmed={dimmed} />, () => onChoose(entry), title)
        })}
      </ol>
    </section>
  )
}

function ResultsSkeleton() {
  return (
    <div role="status" aria-label="Searching" className="flex flex-col">
      {Array.from({ length: 8 }, (_, row) => (
        <div key={row} aria-hidden className="flex h-14 items-center gap-3">
          <Skeleton className={cn('size-10 shrink-0', row === 0 ? 'rounded-full' : 'rounded-[5px]')} />
          <div className="flex flex-col gap-2"><Skeleton className="h-3 w-40" /><Skeleton className="h-2.5 w-24" /></div>
        </div>
      ))}
    </div>
  )
}

