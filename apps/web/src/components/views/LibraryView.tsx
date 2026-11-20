import type { AlbumSummary, ArtistSummary, LibrarySort, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { Disc3, ListMusic, MicVocal, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, CardGrid, PlaylistCard } from '@/components/music/Cards'
import { PageTitle } from '@/components/music/SectionHeader'
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

type SortProps = { sort: LibrarySort; onSortChange: (sort: LibrarySort) => void }

function LibraryPage({ count, sort, children }: { count: string; sort?: SortProps; children: ReactNode }) {
  return (
    <Page className="flex flex-col gap-5">
      <PageTitle>Library</PageTitle>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Library sections" className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          {tabs.map(tab => <NavLink key={tab.to} to={tab.to} className={pillClass}>{tab.label}</NavLink>)}
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-medium text-quiet">{count}</span>
          {sort && <Select label="Sort by" prefix="Sort:" value={sort.sort} onValueChange={sort.onSortChange} options={sortOptions} />}
        </div>
      </div>
      <div className="mt-2">{children}</div>
    </Page>
  )
}

export function LibraryAlbumsView({ albums, onPlayAlbum, ...sort }: SortProps & { albums: AlbumSummary[]; onPlayAlbum: (album: AlbumSummary) => void }) {
  return (
    <LibraryPage count={plural(albums.length, 'album')} sort={sort}>
      {albums.length
        ? <VirtualGrid label="Albums" items={albums} getKey={album => album.id} renderItem={album => <AlbumCard album={album} onPlay={() => onPlayAlbum(album)} />} />
        : <EmptyState icon={<Disc3 />} title="No albums yet" description="Add a library folder in Admin and your music shows up here as it is scanned." />}
    </LibraryPage>
  )
}

export function LibraryArtistsView({ artists, ...sort }: SortProps & { artists: ArtistSummary[] }) {
  return (
    <LibraryPage count={plural(artists.length, 'artist')} sort={sort}>
      {artists.length
        ? <VirtualGrid label="Artists" items={artists} getKey={artist => artist.id} renderItem={artist => <ArtistCard artist={artist} />} />
        : <EmptyState icon={<MicVocal />} title="No artists yet" description="Artists appear once their music is in your library." />}
    </LibraryPage>
  )
}

export function LibrarySongsView({ tracks, ...sort }: SortProps & { tracks: TrackSummary[] }) {
  const actions = useTrackActions(tracks, { type: 'other', id: null, title: 'Songs' })
  return (
    <LibraryPage count={plural(tracks.length, 'song')} sort={sort}>
      <div className="-mx-2"><VirtualTrackList label="Songs" tracks={tracks} variant="compact" {...actions} /></div>
    </LibraryPage>
  )
}

export function LibraryPlaylistsView({ playlists, onCreate, onPlayPlaylist }: { playlists: PlaylistSummary[]; onCreate: () => void; onPlayPlaylist: (playlist: PlaylistSummary) => void }) {
  return (
    <LibraryPage count={plural(playlists.length, 'playlist')}>
      {playlists.length
        ? (
          <CardGrid>
            {playlists.map(playlist => <PlaylistCard key={playlist.id} playlist={playlist} onPlay={() => onPlayPlaylist(playlist)} />)}
            <button type="button" onClick={onCreate} className="flex aspect-square flex-col items-center justify-center gap-2 rounded-cover border-2 border-dashed border-stroke text-sm font-semibold text-muted transition hover:border-accent hover:text-accent">
              <Plus className="size-7" />New playlist
            </button>
          </CardGrid>
        )
        : <EmptyState icon={<ListMusic />} title="No playlists yet" action={<Button variant="primary" onClick={onCreate}><Plus />New playlist</Button>} />}
    </LibraryPage>
  )
}
