import type { AlbumSummary, ArtistSummary, LibrarySort, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { Disc3, FolderPlus, ListMusic, MicVocal, Plus, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, CardGrid, PlaylistCard } from '@/components/music/Cards'
import { PageTitle } from '@/components/music/SectionHeader'
import { GridSkeleton, TrackRowsSkeleton } from '@/components/music/Skeletons'
import { VirtualTrackList } from '@/components/music/TrackList'
import { VirtualGrid } from '@/components/music/VirtualGrid'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { Select, type SelectOption } from '@/components/ui/select'
import { pillClass } from '@/components/ui/tabs'
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
  /** Admins are pointed at the library settings when it is empty. */
  canAddMusic: boolean
}

function LibraryPage({ count, controls, children }: { count?: string; controls?: ReactNode; children: ReactNode }) {
  return (
    <Page className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <PageTitle>Library</PageTitle>
        {count && <span className="pb-1.5 text-[13px] font-medium text-muted">{count}</span>}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface/60 p-1.5 shadow-[inset_0_0_0_1px_var(--stroke)]">
        <nav aria-label="Library sections" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {tabs.map(tab => <NavLink key={tab.to} to={tab.to} className={pillClass}>{tab.label}</NavLink>)}
        </nav>
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      </div>
      <div className="mt-2">{children}</div>
    </Page>
  )
}

function listCount<T>({ items, more }: Pick<LibraryListProps<T>, 'items' | 'more'>, one: string) {
  if (!items) return undefined
  return more ? `${items.length.toLocaleString()}+ ${one}s` : plural(items.length, one)
}

function ListControls<T>({ sort, onSortChange, genres, genre, onGenreChange }: LibraryListProps<T>) {
  return (
    <>
      {genres && genres.length > 0 && onGenreChange && (
        <Select
          label="Genre"
          prefix="Genre:"
          value={genre ?? allGenres}
          onValueChange={value => onGenreChange(value === allGenres ? undefined : value)}
          options={[{ value: allGenres, label: 'All' }, ...genres.map(name => ({ value: name, label: name }))]}
        />
      )}
      <Select label="Sort by" prefix="Sort:" value={sort} onValueChange={onSortChange} options={sortOptions} />
    </>
  )
}

/** Nothing to list: a filter that matched nothing, or a library with no music yet. */
function Empty({ icon, title, genre, onGenreChange, canAddMusic }: { icon: ReactNode; title: string; genre?: string; onGenreChange?: (genre: undefined) => void; canAddMusic: boolean }) {
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
      description={canAddMusic ? 'Add a music folder and your music shows up here as it is scanned.' : 'Music shows up here once an admin of this server adds a music folder.'}
      action={canAddMusic && <Button asChild variant="primary"><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>}
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
          : <Empty icon={<Disc3 />} title="No albums yet" {...list} />}
    </LibraryPage>
  )
}

export function LibraryArtistsView(list: LibraryListProps<ArtistSummary>) {
  return (
    <LibraryPage count={listCount(list, 'artist')} controls={<ListControls {...list} />}>
      {!list.items
        ? <GridSkeleton round />
        : list.items.length
          ? <VirtualGrid label="Artists" items={list.items} getKey={artist => artist.id} onEndReached={list.onEndReached} renderItem={artist => <ArtistCard artist={artist} />} />
          : <Empty icon={<MicVocal />} title="No artists yet" {...list} />}
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
          : <Empty icon={<ListMusic />} title="No songs yet" {...list} />}
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
              <button type="button" onClick={onCreate} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-cover border-2 border-dashed border-stroke text-sm font-semibold text-muted transition hover:border-accent hover:text-accent">
                <Plus className="size-7" />New playlist
              </button>
            </CardGrid>
          )
          : <EmptyState icon={<ListMusic />} title="No playlists yet" description="Make one for a mood, a trip or a friend. Public playlists show up for everyone on this server." action={<Button variant="primary" onClick={onCreate}><Plus />New playlist</Button>} />}
    </LibraryPage>
  )
}
