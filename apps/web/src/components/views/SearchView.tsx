import { searchItemKey, tooShortToSearch, type RecentSearch, type SearchFilter, type SearchItem } from '@squirmy/client-core'
import type { TrackSummary } from '@squirmy/contracts'
import { MoreHorizontal, Play, RotateCw, Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react'
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
import { LoadError } from '@/components/ui/query-state'
import { SearchField } from '@/components/ui/search-field'
import { pillClass } from '@/components/ui/tabs'
import { albumPresentation, canFetch, genreColor, isPlayable, UNAVAILABLE_LABEL, unavailableLabel } from '@/lib/catalog'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls, useTrackPlayback } from '@/player/player-context'
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
  /** The failed search is being asked again. */
  retrying?: boolean
  /** A filter's list goes on: called as its end comes into view. */
  loadMore?: () => void
  hasMore?: boolean
  /** The next page did not load: the list ends with the failure and Try again (`loadMore`), not more requests. */
  moreFailed?: boolean
  moreError?: unknown
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
  /** Null while they load. */
  genres: string[] | null
  onBrowseGenre: (genre: string) => void
  /** Opens an artist, album or playlist; plays a song (on its own, so autoplay follows it), or opens the album of one that does not play. */
  onChoose: (item: SearchItem) => void
}

/** How many recently viewed results the page offers. */
const RECENT_ITEMS = 10

/** A row's own control (the link or button that opens or plays it), which the arrow keys move between. */
const rowControl = 'data-search-row'
/** The rows' controls that can take focus: none in a list of an earlier query's results, which is inert. */
const rowControls = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLElement>(`[${rowControl}]`) ?? [])].filter(control => !control.closest('[inert]'))

/**
 * One list of results for what is typed, every kind mixed and ranked by the server, with
 * chips that narrow it to one kind and page further. Music on the server and music it can
 * fetch look the same; what does not play is gray. Enter in the field opens or plays the best
 * match; the arrow keys move from the field down through the rows (and back up to it), each
 * row a link or button of its own beside its heart and menu. With nothing typed it offers
 * recently viewed results and genres, or says what to do.
 */
export function SearchView(props: SearchViewProps) {
  const { query, onQueryChange, filter, onFilterChange, list, recents, onRemoveRecent, onClearRecents, genres, onBrowseGenre, onChoose } = props
  const term = query.trim()
  const fieldId = useId()
  const rows = useRef<HTMLDivElement>(null)
  const recentItems = useMemo(() => recents.slice(0, RECENT_ITEMS), [recents])
  const hasRecents = recentItems.length > 0

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      const first = rowControls(rows.current)[0]
      if (!first) return
      event.preventDefault()
      first.focus()
    } else if (event.key === 'Enter') {
      // Results of an earlier query are not what Enter should open.
      const best = term && !list.stale ? list.items?.[0] : undefined
      if (!best) return
      event.preventDefault()
      onChoose(best)
    }
  }
  // Up and Down move between the rows, Up from the first back to the field; Home and End go to either end.
  const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute(rowControl)) return
    const controls = rowControls(rows.current)
    const at = controls.indexOf(event.target)
    const next = event.key === 'ArrowDown' ? controls[at + 1]
      : event.key === 'ArrowUp' ? (at > 0 ? controls[at - 1] : document.getElementById(fieldId))
        : event.key === 'Home' ? controls[0]
          : event.key === 'End' ? controls.at(-1)
            : undefined
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <>
      {/* The field follows the title and takes the room there is, instead of sitting at the far end like a page's controls. */}
      <PageHeader title="Search" controls="fill">
        <SearchField
          id={fieldId}
          value={query}
          onValueChange={onQueryChange}
          onKeyDown={onFieldKeyDown}
          aria-label="Search"
          placeholder="Songs, albums, artists, playlists"
          autoFocus
          className="w-full max-w-md"
        />
      </PageHeader>
      <Page className="flex flex-col gap-6">
        <div ref={rows} onKeyDown={onRowsKeyDown} className="contents">
          {term ? (
            <>
              <Filters value={filter} onChange={onFilterChange} />
              <Results term={term} filter={filter} list={list} onChoose={onChoose} />
            </>
          ) : hasRecents && (
            <RecentlyViewed
              items={recentItems}
              onChoose={onChoose}
              onRemove={onRemoveRecent}
              onClear={onClearRecents}
            />
          )}
        </div>
        {!term && (
          <>
            {!hasRecents && genres?.length === 0 && (
              // Nothing searched yet and no genres to browse: say what the page is for.
              <EmptyState icon={<Search />} title="Search your music" description="Find songs, albums, artists and playlists by name." headingLevel={2} />
            )}
            {genres && genres.length > 0 && (
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
  onChoose: (item: SearchItem) => void
}

function Results({ term, filter, list, onChoose }: ResultsProps) {
  const { items, stale, pending, failed, catalogFailed, unavailable, retry, retrying = false, loadMore, hasMore, moreFailed, moreError } = list
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
        action={<Button variant="secondary" pending={retrying} onClick={retry}>{!retrying && <RotateCw />}Try again</Button>}
      />
    )
  }
  if (tooShortToSearch(term) && filter !== 'playlist') return <p className="text-sm text-muted-foreground">Keep typing: search needs at least two letters or digits.</p>
  if (!items) return <ResultsSkeleton />
  const kind = filter === 'all' ? 'results' : filterLabels[filter].toLowerCase()
  // A catalog that could not be searched is no answer: "No results" would say there is nothing to find.
  if (!items.length && !pending && !stale && !catalogFailed) {
    return (
      <EmptyState
        icon={<Search />}
        title={`No ${kind} for “${term}”`}
        description={filter === 'all' ? 'Check the spelling, or try an artist, album or song name.' : 'Try All, or another spelling.'}
      />
    )
  }
  return (
    // A row reads across: past this width its duration and menu drift away from its title.
    <div aria-busy={stale || pending || undefined} className="flex max-w-4xl flex-col gap-3">
      {catalogFailed && !stale && (
        <LoadError
          title="Couldn’t search the catalog"
          description={items.length ? 'Only music on this server is listed.' : `Nothing on this server matches “${term}”.`}
          retrying={retrying}
          onRetry={retry}
          className="[overflow-wrap:anywhere]"
        />
      )}
      {items.length > 0 && (
        // Results of an earlier query stay, faded, while this one's load, but are not there to be opened.
        <ol aria-label={`Results for ${term}`} inert={stale || undefined} className="-mx-2.5 flex flex-col">
          {items.map(item => (
            <ResultRow
              key={searchItemKey(item)}
              item={item}
              stale={stale}
              onChoose={() => onChoose(item)}
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
          ))}
        </ol>
      )}
      {moreFailed && !stale && loadMore
        ? <LoadError title="More results didn’t load" error={moreError} retrying={pending} onRetry={loadMore} />
        : (pending || hasMore) && <MoreResults loading={pending} onEndReached={hasMore ? loadMore : undefined} />}
    </div>
  )
}

type ResultRowProps = {
  item: SearchItem
  stale: boolean
  onChoose: () => void
  trackMenu?: (track: TrackSummary) => MenuEntry[]
  resultMenu: ReturnType<typeof useResultMenus>
  onLike?: () => void
}

/** A row's highlight while the keyboard is on its own control, as the pointer's is on hover. */
const focusedRow = 'has-[[data-search-row]:focus-visible]:bg-accent'

/**
 * One result: its artwork, its name and "Kind · Artist". The row's own control (a link
 * over the whole row) opens an artist, album or playlist and plays a song; a song that does not
 * play is gray and opens its album. Its heart and its menu (the overflow button, or a right
 * click) are controls of their own beside it, the menu the one the same kind has everywhere.
 */
function ResultRow({ item, stale, onChoose, trackMenu, resultMenu, onLike }: ResultRowProps) {
  const viewer = useViewer()
  const controls = usePlayerControls()
  const detailId = useId()
  const { title, detail } = searchItemText(item)
  const track = item.type === 'track' ? item.track : null
  const unavailable = track ? !isPlayable(track, viewer) : false
  const unavailableText = track ? unavailableLabel(track, viewer) : UNAVAILABLE_LABEL
  const dimmed = item.type === 'album' ? albumPresentation(item.album, viewer) === 'dimmed'
    : item.type === 'artist' ? !item.artist.inLibrary && !canFetch(viewer) : unavailable
  // Only this result's part of the session, so a volume or position change renders no rows.
  const playback = useTrackPlayback(track?.id ?? '')
  const current = playback !== null
  const playing = playback === 'playing' || playback === 'loading'
  const loading = playback === 'loading'
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
        data-search-row=""
        // A song's name is what pressing it does; the row's "Song · Artist" says which one.
        aria-label={unavailable ? `${title}, ${unavailableText}` : playing ? `Pause ${title}` : `Play ${title}`}
        aria-describedby={detailId}
        onClick={current && !unavailable ? controls.togglePlay : onChoose}
        className={overlay}
      />
    )
    : item.type === 'playlist'
      ? <Link to={`/playlist/${item.playlist.id}`} data-search-row="" aria-label={`${title}, ${detail}`} onClick={onLinkClick} className={overlay} />
      : (
        <PrefetchLink
          kind={item.type}
          id={item.type === 'artist' ? item.artist.id : item.album.id}
          to={item.type === 'artist' ? `/artist/${item.artist.id}` : `/album/${item.album.id}`}
          data-search-row=""
          aria-label={`${title}, ${detail}`}
          onClick={onLinkClick}
          className={overlay}
        />
      )

  return (
    <ContextMenu entries={menu}>
      <li
        // A song that does not play still opens its album, and its heart and menu work. Its control's name says "Not available".
        title={unavailable ? unavailableText : undefined}
        // Its own size container: the duration shows when the row, not the window, has room for it.
        className={cn('group/row @container relative h-14', searchRowClass(false, stale), focusedRow)}
      >
        <div className="relative size-10 shrink-0">
          <SearchItemArt item={item} dimmed={dimmed} className="size-10" />
          {track && !unavailable && (
            // Over a song's cover: the playing marker, the buffering spinner, or a play button on hover.
            // The markers are decoration, but music on its way is said, as a track row's spinner is.
            <div aria-hidden={!loading || undefined} className={cn('absolute inset-0 flex items-center justify-center rounded-[5px] text-white transition-colors', current ? 'bg-black/50' : 'opacity-0 group-hover/row:bg-black/50 group-hover/row:opacity-100')}>
              {loading ? <Spinner label="Loading" className="size-4 text-white" />
                : current ? (playing ? <Equalizer playing className="text-white" /> : <Play className="size-3.5" fill="currentColor" />)
                  : <Play className="size-3.5" fill="currentColor" />}
            </div>
          )}
        </div>
        <SearchRowBody art={null} title={title} detail={detail} detailId={detailId} dimmed={dimmed} current={current} explicit={track?.explicit ?? false} note={unavailable ? unavailableText : undefined} />
        {primary}
        {/* A finger gets 44 px for the heart and the menu, with no gap between them. */}
        <div className="relative z-10 flex shrink-0 items-center gap-1 pointer-coarse:gap-0">
          {track && onLike && (
            <SaveHeart id={track.id} liked={track.liked} onToggle={onLike} title={title} tooltip={false} size="sm" className={cn('pointer-coarse:size-11', !track.liked && revealed)} />
          )}
          {track && <span className={cn('hidden min-w-10 shrink-0 whitespace-nowrap text-right text-xs tabular @md:block', unavailable ? 'text-faded-foreground' : 'text-muted-foreground')}>{track.durationMs ? formatDuration(track.durationMs) : '–'}</span>}
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
const revealed = 'md:pointer-fine:opacity-0 md:pointer-fine:group-hover/row:opacity-100 md:pointer-fine:group-has-[:focus-visible]/row:opacity-100 md:pointer-fine:group-has-[[data-state=open]]/row:opacity-100'

/**
 * The end of a list: a spinner while more is on its way, and the next page loading as it comes
 * into view. A page that failed is the list's `LoadError` instead, so nothing here asks again.
 */
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

type RecentlyViewedProps = {
  items: RecentSearch[]
  onChoose: (item: SearchItem) => void
  onRemove: (key: string) => void
  onClear: () => void
}

/** Recently viewed results, each removable, with one button that clears them all. */
function RecentlyViewed({ items, onChoose, onRemove, onClear }: RecentlyViewedProps) {
  const viewer = useViewer()
  return (
    <section aria-labelledby="search-recent" className="max-w-4xl">
      <SectionHeader id="search-recent" title="Recently viewed" action={<Button aria-label="Clear all recently viewed" variant="ghost" size="sm" onClick={onClear}>Clear all</Button>} />
      <ol aria-labelledby="search-recent" className="-mx-2.5 flex flex-col">
        {items.map(entry => {
          const key = searchItemKey(entry)
          const { title, detail } = searchItemText(entry)
          const dimmed = entry.type === 'track' ? !isPlayable(entry.track, viewer) : entry.type === 'album' ? albumPresentation(entry.album, viewer) === 'dimmed' : false
          return (
            <li key={key} className={cn('group/row relative h-12', searchRowClass(false, false), focusedRow)}>
              <SearchRowBody art={<SearchItemArt item={entry} dimmed={dimmed} className="size-9" />} title={title} detail={detail} dimmed={dimmed} />
              <button type="button" data-search-row="" aria-label={`${title}, ${detail}`} onClick={() => onChoose(entry)} className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <IconButton label={`Remove ${title} from recently viewed`} tooltip={false} size="sm" onClick={() => onRemove(key)} className={cn('relative z-10 pointer-coarse:size-11', revealed)}>
                <X />
              </IconButton>
            </li>
          )
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
