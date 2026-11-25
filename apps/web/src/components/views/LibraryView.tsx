import type { AlbumSummary, ArtistSummary, LibraryItemsSort, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { CloudOff, Disc3, FolderPlus, LayoutGrid, List, ListMusic, MicVocal, Plus, Search, SearchX, Server, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/errors'
import { usePrefetch } from '@/api/prefetch'
import { searchesServer } from '@/api/queries'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, AlbumRow, ArtistCard, CollectionRow, LikedCard, Monogram, PlaylistCard, PlaylistRow, type CardPin } from '@/components/music/Cards'
import { LikedCover } from '@/components/music/CollectionArt'
import { Cover } from '@/components/music/Cover'
import { GridSkeleton, TrackRowsSkeleton } from '@/components/music/Skeletons'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList, VirtualTrackList } from '@/components/music/TrackList'
import { VirtualGrid } from '@/components/music/VirtualGrid'
import { Button } from '@/components/ui/button'
import { EmptyState, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { SearchField } from '@/components/ui/search-field'
import { LoadError } from '@/components/ui/query-state'
import { Select, type SelectOption } from '@/components/ui/select'
import { pillClass } from '@/components/ui/tabs'
import { canFetch } from '@/lib/catalog'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'
import { filterLabels, LIBRARY_FILTERS, type LibraryFilterName, type LibraryLayout } from './library-state'

const sortLabels: Record<LibraryItemsSort, string> = { played: 'Recently played', recent: 'Recently added', title: 'Title', artist: 'Artist', year: 'Year' }

/**
 * One tile or row of the Library: Liked Songs, a playlist, an album or an artist. `pinned` is
 * known for All's own list (not its search), whose first page starts with the pins.
 */
export type LibraryItem =
  | { kind: 'liked'; pinned?: boolean }
  | { kind: 'playlist'; playlist: PlaylistSummary; pinned?: boolean }
  | { kind: 'album'; album: AlbumSummary; pinned?: boolean }
  | { kind: 'artist'; artist: ArtistSummary; pinned?: boolean }

/** A request that failed, and how to ask again. */
export type Failure = { error: unknown; onRetry: () => void; retrying?: boolean }

/** Below this width the page header has room for the title alone, so the chips wrap above the list instead. */
const NARROW_QUERY = '(width < 768px)'

const itemKey = (item: LibraryItem) => (item.kind === 'liked' ? 'liked' : item.kind === 'playlist' ? item.playlist.id : item.kind === 'album' ? item.album.id : item.artist.id)

export type LibraryViewProps = {
  /**
   * `server`: the server's music (`/collection`, Home's See all) rather than the user's
   * library, with its own title and wording, the Albums, Artists and Songs chips, and no pins.
   */
  server?: boolean
  filter: LibraryFilterName
  /** Where each filter chip goes: the filter, with the sort kept. */
  filterHref: (filter: LibraryFilterName) => string
  /** The order shown, and the ones this filter offers (none for artists and playlists). */
  sort: LibraryItemsSort
  sorts: LibraryItemsSort[]
  onSortChange: (sort: LibraryItemsSort) => void
  layout: LibraryLayout
  onLayoutChange: (layout: LibraryLayout) => void
  /** "Find in your library": two characters or more search the whole library, one filters what is loaded. */
  query: string
  onQueryChange: (query: string) => void
  /** A genre the albums and songs are narrowed to, from Search's genres. */
  genre?: string
  onClearGenre: () => void
  /** What the filter shows, undefined while it loads. Songs fill `tracks` instead. */
  items?: LibraryItem[]
  tracks?: TrackSummary[]
  /** Under All, the songs a search of the whole library matched, shown after the collections. */
  songMatches?: TrackSummary[]
  /** The playlists did not load: Liked Songs and the albums still show, with a way to ask again. */
  playlistsFailure?: Failure
  /**
   * The filter's own list (All's, albums, artists or songs) did not load. The chips and the
   * toolbar stay, and under Albums the playlists that loaded show above the message.
   */
  listFailure?: Failure
  /** The search of the whole library failed. It says so in place of the matches, even when the list itself loaded. */
  searchFailure?: Failure
  /** "60+ albums" for one kind; nothing for All or while searching. */
  count?: string
  /** "24 songs" under Liked Songs. */
  likedCount?: string
  /** Nothing is in the library yet (no albums): the page says where music comes from. */
  libraryEmpty: boolean
  /** The search's answer for what is typed is on its way. */
  pending: boolean
  /** The search hit its limit: more letters narrow it. */
  capped: boolean
  /** The next page is loading. */
  loadingMore: boolean
  onEndReached?: () => void
  /** Admins are also pointed at the library settings when it is empty. */
  canAddMusic: boolean
  onPlayAlbum: (album: AlbumSummary) => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
  onPlayLiked: () => void
  onPlaySong: (index: number) => void
  onNewPlaylist: () => void
  /** Pins an item whose `pinned` is known to the top of All, or unpins it; a failure is said on the menu entry. */
  onPin?: (item: LibraryItem, pinned: boolean) => Promise<unknown>
}

const serverEmpty = { icon: <Disc3 />, title: 'Nothing on this server yet', description: 'Music scanned from the server’s folders, uploaded or dropped in its inbox shows up here.' }

/** The server's music has no playlists of its own, and no All: its lists are the albums, their artists and the songs. */
const SERVER_FILTERS = ['albums', 'artists', 'songs'] as const satisfies readonly LibraryFilterName[]

/** An item's pin, where it is known. */
function itemPin(item: LibraryItem, onPin: LibraryViewProps['onPin']): CardPin | undefined {
  if (item.pinned === undefined || !onPin) return undefined
  const pinned = item.pinned
  return { pinned, onToggle: () => onPin(item, !pinned) }
}

const empties = {
  albums: { icon: <Disc3 />, title: 'Add music to your library', description: 'Albums and songs you save show up here, with the music you upload. Find something you love and tap the heart.' },
  artists: { icon: <MicVocal />, title: 'No artists yet', description: 'Artists you save, and the artists of albums in your library, show up here.' },
  songs: { icon: <ListMusic />, title: 'No songs yet', description: 'Songs you save, and the songs of albums you save, show up here.' },
}

/**
 * The library in one place, as on iOS: filter chips (All, Playlists, Albums, Artists, Songs), a
 * sort where the filter has one, grid or list, and a search of the library. All is Liked Songs,
 * the playlists, the albums and the artists in one grid, in the sort's order; searched, the
 * songs that match follow them, as on iOS.
 */
export function LibraryView(props: LibraryViewProps) {
  const { filter, filterHref, query, onQueryChange, genre, onClearGenre, count, sort, sorts, onSortChange, layout, onLayoutChange, capped, loadingMore, pending } = props
  const songs = filter === 'songs'
  const shown = songs ? props.tracks : props.items
  const searching = query.trim().length > 0
  const songMatches = songs ? [] : props.songMatches ?? []
  const { playlistsFailure, searchFailure, listFailure } = props
  const narrow = useMediaQuery(NARROW_QUERY)
  const server = props.server ?? false
  const chips = (server ? SERVER_FILTERS : LIBRARY_FILTERS).map(name => (
    <Link key={name} to={filterHref(name)} aria-current={name === filter ? 'page' : undefined} className={pillClass}>{filterLabels[name]}</Link>
  ))
  // The list failed. Under All, what did load (Liked Songs, the playlists) still shows above the message.
  const listFailed = Boolean(listFailure) && !searching && !searchFailure
  const failedList = listFailed && (
    <LoadError
      title={server ? `This server’s ${filterLabels[filter].toLowerCase()} didn’t load` : filter === 'all' ? 'Your library didn’t load' : `Your ${filterLabels[filter].toLowerCase()} didn’t load`}
      error={listFailure!.error}
      onRetry={listFailure!.onRetry}
      retrying={listFailure!.retrying}
      className={filter === 'all' && shown?.length ? 'mt-6' : undefined}
    />
  )

  return (
    <>
      <PageHeader title={server ? 'On this server' : 'Library'} nav={narrow ? undefined : chips} navLabel={server ? 'Filters' : 'Library filters'} />
      <Page>
        {/* A phone's header has room for the title alone. Here every chip shows, wrapping if it must, rather than hiding past a sideways swipe. */}
        {narrow && <nav aria-label={server ? 'Filters' : 'Library filters'} className="-mx-1 -mt-2 mb-3 flex flex-wrap gap-1 px-1 py-1">{chips}</nav>}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchField value={query} onValueChange={onQueryChange} placeholder={server ? 'Find on this server' : 'Find in your library'} className="w-full sm:w-64" />
          {genre && (
            <span className="inline-flex h-8 items-center gap-1 rounded-md border border-input pl-2.5 pr-1 text-sm">
              <span className="text-muted-foreground">Genre:</span> {genre}
              <IconButton label="Show every genre" size="xs" onClick={onClearGenre}><X /></IconButton>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {count && !searching && <span className="shrink-0 text-xs tabular text-muted-foreground">{count}</span>}
            {filter === 'playlists'
              ? <Button variant="outline" size="sm" onClick={props.onNewPlaylist}><Plus />New playlist</Button>
              // Matches from the server come best first, whatever the sort.
              : sorts.length > 0 && !searchesServer(query) && (
                <Select
                  label="Sort by"
                  prefix="Sort:"
                  value={sort}
                  onValueChange={onSortChange}
                  options={sorts.map((value): SelectOption<LibraryItemsSort> => ({ value, label: sortLabels[value] }))}
                  size="sm"
                />
              )}
            {!songs && (
              <IconButton label={layout === 'grid' ? 'Show list view' : 'Show grid view'} size="sm" variant="outline" onClick={() => onLayoutChange(layout === 'grid' ? 'list' : 'grid')}>
                {layout === 'grid' ? <List /> : <LayoutGrid />}
              </IconButton>
            )}
          </div>
        </div>

        {playlistsFailure && !searchFailure && <PlaylistsFailed {...playlistsFailure} />}

        {searchFailure
          ? <EmptyState icon={<CloudOff />} title={server ? 'Couldn’t search this server' : 'Couldn’t search your library'} description={errorMessage(searchFailure.error)} action={<Button variant="primary" onClick={searchFailure.onRetry}>Try again</Button>} />
          // Nothing else to show: the message takes the list's place.
          : listFailed && !shown?.length
            ? failedList
          : shown === undefined
            ? (songs || layout === 'list' ? <TrackRowsSkeleton rows={12} art /> : <GridSkeleton round={filter === 'artists'} />)
            : shown.length === 0 && songMatches.length === 0
              ? <Nothing {...props} searching={searching} />
              : songs
                ? <Songs tracks={props.tracks!} onPlay={props.onPlaySong} onEndReached={props.onEndReached} />
                : (
                  <>
                    {shown.length > 0 && <Collections {...props} items={props.items!} />}
                    {failedList}
                    {songMatches.length > 0 && <SongMatches tracks={songMatches} />}
                  </>
                )}

        {!searchFailure && shown !== undefined && shown.length > 0 && filter === 'all' && props.libraryEmpty && !searching && <LibraryEmpty canAddMusic={props.canAddMusic} />}
        {(loadingMore || (searching && pending && (shown?.length ?? 0) > 0)) && <div className="flex justify-center py-6"><Spinner /></div>}
        {capped && !searchFailure && <p className="py-6 text-center text-sm text-muted-foreground">Showing the best matches. Type more to narrow them down.</p>}
      </Page>
    </>
  )
}

/** The playlists did not load. A line over the rest, which does not need them, with a way to ask again. */
function PlaylistsFailed({ error, onRetry }: Failure) {
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
      <CloudOff aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1"><span className="font-medium">Your playlists didn’t load.</span> <span className="text-muted-foreground">{errorMessage(error)}</span></p>
      <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  )
}

/** Under All, the songs a search matched: what is played is these matches, from the one chosen. */
function SongMatches({ tracks }: { tracks: TrackSummary[] }) {
  const actions = useTrackActions(tracks, { type: 'other', id: null, title: 'Songs' })
  return (
    <section aria-labelledby="library-songs" className="mt-8">
      <SectionHeader id="library-songs" title="Songs" className="mb-1" />
      <div className="-mx-2"><TrackList label="Songs" tracks={tracks} variant="compact" header={false} {...actions} /></div>
    </section>
  )
}

function Songs({ tracks, onPlay, onEndReached }: { tracks: TrackSummary[]; onPlay: (index: number) => void; onEndReached?: () => void }) {
  const actions = useTrackActions(tracks, { type: 'other', id: null, title: 'Songs' }, { onPlay })
  return <div className="-mx-2"><VirtualTrackList label="Songs" tracks={tracks} variant="compact" onEndReached={onEndReached} {...actions} /></div>
}

function Collections({ items, layout, filter, likedCount, onEndReached, onPlayAlbum, onPlayPlaylist, onPlayLiked, onPin }: LibraryViewProps & { items: LibraryItem[] }) {
  const wants = useAlbumWants()
  const list = layout === 'list'
  const label = filter === 'all' ? 'Library' : filterLabels[filter]
  return (
    <div className={cn(list && '-mx-2')}>
      <VirtualGrid
        label={label}
        list={list}
        items={items}
        getKey={itemKey}
        onEndReached={onEndReached}
        renderItem={item => {
          const pin = itemPin(item, onPin)
          if (list) return <ItemRow item={item} pin={pin} likedCount={likedCount} onPlayAlbum={onPlayAlbum} onPlayPlaylist={onPlayPlaylist} onPlayLiked={onPlayLiked} />
          switch (item.kind) {
            case 'liked': return <LikedCard count={likedCount} onPlay={onPlayLiked} pin={pin} />
            case 'playlist': return <PlaylistCard playlist={item.playlist} onPlay={() => onPlayPlaylist(item.playlist)} pin={pin} />
            case 'album': return <AlbumCard album={item.album} onPlay={() => onPlayAlbum(item.album)} pin={pin} {...wants(item.album)} />
            case 'artist': return <ArtistCard artist={item.artist} pin={pin} />
          }
        }}
      />
    </div>
  )
}

const rowArt = 'size-11 rounded-md'

/** A row of the list layout, with the same play button (and, for albums, menu) as its card. */
function ItemRow({ item, pin, likedCount, onPlayAlbum, onPlayPlaylist, onPlayLiked }: Pick<LibraryViewProps, 'likedCount' | 'onPlayAlbum' | 'onPlayPlaylist' | 'onPlayLiked'> & { item: LibraryItem; pin?: CardPin }) {
  switch (item.kind) {
    case 'liked': return <CollectionRow to="/liked" title="Liked Songs" subtitle={likedCount ? `Playlist · ${likedCount}` : 'Playlist'} art={<LikedCover className={rowArt} />} onPlay={onPlayLiked} pin={pin} />
    case 'playlist': return <PlaylistRow playlist={item.playlist} onPlay={() => onPlayPlaylist(item.playlist)} className={rowArt} pin={pin} />
    case 'album': return <AlbumRow album={item.album} onPlay={() => onPlayAlbum(item.album)} className={rowArt} pin={pin} />
    case 'artist': return <ArtistRow artist={item.artist} pin={pin} />
  }
}

function ArtistRow({ artist, pin }: { artist: ArtistSummary; pin?: CardPin }) {
  const viewer = useViewer()
  const prefetch = usePrefetch({ kind: 'artist', id: artist.id })
  // The same rule as `ArtistCard`.
  const dimmed = !artist.inLibrary && !canFetch(viewer)
  const art = artist.image ? <Cover artwork={artist.image} size={96} round dimmed={dimmed} className="size-11" /> : <Monogram name={artist.name} className="size-11 text-base" />
  return <CollectionRow to={`/artist/${artist.id}`} title={artist.name} subtitle="Artist" dimmed={dimmed} prefetch={prefetch} art={art} pin={pin} />
}

/** Nothing to list: a search or a genre that matched nothing, or a library with nothing in it yet. */
function Nothing({ filter, searching, pending, genre, onClearGenre, canAddMusic, server }: LibraryViewProps & { searching: boolean }) {
  if (searching) {
    if (pending) return <TrackRowsSkeleton rows={6} art />
    return <EmptyState icon={<SearchX />} title="Nothing found" description="Try another search or filter." />
  }
  if (genre) {
    return <EmptyState icon={<SearchX />} title={`Nothing tagged “${genre}”`} action={<Button variant="primary" onClick={onClearGenre}>Show every genre</Button>} />
  }
  if (server) return <LibraryEmpty canAddMusic={canAddMusic} server {...serverEmpty} />
  if (filter === 'artists' || filter === 'songs') return <LibraryEmpty canAddMusic={canAddMusic} {...empties[filter]} />
  return <LibraryEmpty canAddMusic={canAddMusic} />
}

/**
 * An empty library is an invitation: Search is where music is found and saved, and the
 * server's own music is a page away.
 */
function LibraryEmpty({ canAddMusic, icon = empties.albums.icon, title = empties.albums.title, description = empties.albums.description, server = false }: { canAddMusic: boolean; icon?: ReactNode; title?: string; description?: string; server?: boolean }) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={(
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="primary"><Link to="/search"><Search />Find music</Link></Button>
          {!server && <Button asChild variant="outline"><Link to="/collection"><Server />Browse this server</Link></Button>}
          {canAddMusic && <Button asChild variant="outline"><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>}
        </div>
      )}
    />
  )
}
