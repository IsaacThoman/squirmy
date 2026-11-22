import type { AlbumSummary, ArtistSummary, LibrarySort, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { Disc3, FolderPlus, ListMusic, MicVocal, Plus, Search, SearchX } from 'lucide-react'
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router'
import { HeaderLink, Page, PageHeader } from '@/components/layout/Page'
import { useScrollContainer } from '@/components/layout/scroll-context'
import { AlbumCard, ArtistCard, CardGrid, PlaylistCard } from '@/components/music/Cards'
import { GridSkeleton, TrackRowsSkeleton } from '@/components/music/Skeletons'
import { VirtualTrackList } from '@/components/music/TrackList'
import { VirtualGrid } from '@/components/music/VirtualGrid'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Select, type SelectOption } from '@/components/ui/select'
import { plural } from '@/lib/format'
import { useTrackActions } from '@/player/use-track-actions'

const sortOptions: SelectOption<LibrarySort>[] = [
  { value: 'recent', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'year', label: 'Year' },
]

const tabs = [
  { to: '/library/albums', label: 'Albums' },
  { to: '/library/artists', label: 'Artists' },
  { to: '/library/songs', label: 'Songs' },
  { to: '/library/playlists', label: 'Playlists' },
]

/** Select values cannot be empty, so "every genre" has a value of its own. */
const allGenres = '*'

/** How a library list is sorted and filtered, and what it holds so far. */
export type LibraryListProps<T> = {
  /** Undefined while the first page loads. */
  items: T[] | undefined
  /** More pages follow; the count then reads "60+". */
  more: boolean
  onEndReached: () => void
  sort: LibrarySort
  onSortChange: (sort: LibrarySort) => void
  /** Genres to filter by, when the list can be filtered. */
  genres?: string[]
  genre?: string
  onGenreChange?: (genre: string | undefined) => void
  /** Admins are also pointed at the library settings when it is empty. */
  canAddMusic: boolean
}

/**
 * The library is the server's own music (what its owner brought) and what the user added: not
 * everything played. Empty, it says so and where music comes from.
 */
const emptyDescriptions = {
  albums: 'Albums you add to your library and music on this server appear here.',
  artists: 'The artists of albums you add to your library and of music on this server appear here.',
  songs: 'Songs you add to your library and music on this server appear here.',
}

/**
 * Whether the page is narrower than `width`. That is the room the shell leaves the page, which the
 * sidebar and the queue take from, not the window's width.
 */
function usePageNarrowerThan(width: number) {
  const page = useScrollContainer()
  const watch = useCallback((onChange: () => void) => {
    if (!page) return () => {}
    const observer = new ResizeObserver(onChange)
    observer.observe(page)
    return () => observer.disconnect()
  }, [page])
  // The window stands in until the page has been laid out.
  return useSyncExternalStore(watch, () => (page?.clientWidth || window.innerWidth) < width)
}

/** A library list under the header that switches between them. */
function LibraryPage({ count, controls, children }: { count?: string; controls?: ReactNode; children: ReactNode }) {
  // The count and the controls are in the header bar while it has room for them beside the
  // sections. On a narrower page, a phone's above all, they go in a row under it.
  const narrow = usePageNarrowerThan(800)
  const summary = count && <span className="shrink-0 text-xs tabular text-muted-foreground">{count}</span>
  return (
    <>
      <PageHeader title="Library" className="max-md:gap-2" nav={tabs.map(tab => <HeaderLink key={tab.to} to={tab.to}>{tab.label}</HeaderLink>)}>
        {!narrow && (summary || controls) ? <>{summary}{controls}</> : null}
      </PageHeader>
      <Page>
        {narrow && (summary || controls) && (
          <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-2">
            {controls && <div className="flex items-center gap-2">{controls}</div>}
            {summary}
          </div>
        )}
        {children}
      </Page>
    </>
  )
}

function listCount<T>({ items, more }: Pick<LibraryListProps<T>, 'items' | 'more'>, one: string) {
  if (!items) return undefined
  return more ? `${items.length.toLocaleString()}+ ${one}s` : plural(items.length, one)
}

function ListControls<T>({ sort, onSortChange, genres, genre, onGenreChange }: LibraryListProps<T>) {
  const tight = usePageNarrowerThan(480)
  // A genre from the URL that the library does not have is still the one chosen, so it is listed.
  const names = genres && genre && !genres.includes(genre) ? [genre, ...genres] : genres
  return (
    <>
      {names && names.length > 0 && onGenreChange && (
        <Select
          label="Genre"
          prefix="Genre:"
          value={genre ?? allGenres}
          onValueChange={value => onGenreChange(value === allGenres ? undefined : value)}
          options={[{ value: allGenres, label: 'All' }, ...names.map(name => ({ value: name, label: name }))]}
          size="sm"
          className="max-w-44"
        />
      )}
      {/* The sorts explain themselves, so on a phone the prefix makes way for the count beside the controls. */}
      <Select label="Sort by" prefix={tight ? undefined : 'Sort:'} value={sort} onValueChange={onSortChange} options={sortOptions} size="sm" />
    </>
  )
}

type EmptyProps = { icon: ReactNode; title: string; kind: keyof typeof emptyDescriptions; genre?: string; onGenreChange?: (genre: undefined) => void; canAddMusic: boolean }

/** Nothing to list: a filter that matched nothing, or a library with nothing in it yet. */
function Empty({ icon, title, kind, genre, onGenreChange, canAddMusic }: EmptyProps) {
  if (genre) {
    return (
      <EmptyState
        icon={<SearchX />}
        title={`Nothing tagged “${genre}”`}
        action={onGenreChange && <Button variant="primary" onClick={() => onGenreChange(undefined)}>Show every genre</Button>}
      />
    )
  }
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={emptyDescriptions[kind]}
      action={(
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="primary"><Link to="/search"><Search />Find music</Link></Button>
          {canAddMusic && <Button asChild variant="outline"><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>}
        </div>
      )}
    />
  )
}

export function LibraryAlbumsView({ onPlayAlbum, ...list }: LibraryListProps<AlbumSummary> & { onPlayAlbum: (album: AlbumSummary) => void }) {
  return (
    <LibraryPage count={listCount(list, 'album')} controls={<ListControls {...list} />}>
      {!list.items
        ? <GridSkeleton />
        : list.items.length
          ? <VirtualGrid label="Albums" items={list.items} getKey={album => album.id} onEndReached={list.onEndReached} renderItem={album => <AlbumCard album={album} onPlay={() => onPlayAlbum(album)} />} />
          : <Empty icon={<Disc3 />} title="No albums yet" kind="albums" {...list} />}
    </LibraryPage>
  )
}

/** Artists are listed by name only: the server sorts and filters them no other way, so there are no controls. */
export function LibraryArtistsView(list: LibraryListProps<ArtistSummary>) {
  return (
    <LibraryPage count={listCount(list, 'artist')}>
      {!list.items
        ? <GridSkeleton round />
        : list.items.length
          ? <VirtualGrid label="Artists" items={list.items} getKey={artist => artist.id} onEndReached={list.onEndReached} renderItem={artist => <ArtistCard artist={artist} />} />
          : <Empty icon={<MicVocal />} title="No artists yet" kind="artists" canAddMusic={list.canAddMusic} />}
    </LibraryPage>
  )
}

export function LibrarySongsView({ onPlay, ...list }: LibraryListProps<TrackSummary> & { onPlay: (index: number) => void }) {
  const actions = useTrackActions(list.items ?? [], { type: 'other', id: null, title: 'Songs' }, { onPlay })
  return (
    <LibraryPage count={listCount(list, 'song')} controls={<ListControls {...list} />}>
      {!list.items
        ? <TrackRowsSkeleton rows={12} art />
        : list.items.length
          ? <div className="-mx-2"><VirtualTrackList label="Songs" tracks={list.items} variant="compact" onEndReached={list.onEndReached} {...actions} /></div>
          : <Empty icon={<ListMusic />} title="No songs yet" kind="songs" {...list} />}
    </LibraryPage>
  )
}

export function LibraryPlaylistsView({ playlists, onCreate, onPlayPlaylist }: { playlists: PlaylistSummary[] | undefined; onCreate: () => void; onPlayPlaylist: (playlist: PlaylistSummary) => void }) {
  return (
    <LibraryPage count={playlists && plural(playlists.length, 'playlist')}>
      {!playlists
        ? <GridSkeleton count={6} />
        : playlists.length
          ? (
            <CardGrid>
              {playlists.map(playlist => <PlaylistCard key={playlist.id} playlist={playlist} onPlay={() => onPlayPlaylist(playlist)} />)}
              <button
                type="button"
                onClick={onCreate}
                className="flex aspect-square flex-col items-center justify-center gap-2 self-start rounded-cover border border-dashed border-input text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-5" />New playlist
              </button>
            </CardGrid>
          )
          : <EmptyState icon={<ListMusic />} title="No playlists yet" description="Make one for a mood, a trip or a friend. Public playlists show up for everyone on this server." action={<Button variant="primary" onClick={onCreate}><Plus />New playlist</Button>} />}
    </LibraryPage>
  )
}
