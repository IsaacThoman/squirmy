/**
 * Route containers for the music pages. Each one gathers its data (fixtures for now; TanStack
 * Query later) and hands it to a view in components/views.
 */
import type { AlbumSummary, ArtistSummary, LibrarySort, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { Compass } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { AppShell } from '@/components/layout/AppShell'
import { CreatePlaylistDialog } from '@/components/layout/CreatePlaylistDialog'
import { Page } from '@/components/layout/Page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { AlbumView } from '@/components/views/AlbumView'
import { ArtistView } from '@/components/views/ArtistView'
import { HomeView } from '@/components/views/HomeView'
import { LibraryAlbumsView, LibraryArtistsView, LibraryPlaylistsView, LibrarySongsView } from '@/components/views/LibraryView'
import { LikedView, PlaylistView } from '@/components/views/PlaylistView'
import { SearchView } from '@/components/views/SearchView'
import { WantlistView } from '@/components/views/WantlistView'
import {
  albumDetail, albumTracks, artistDetail, featuredAlbum, genres, home, libraryAlbums, libraryArtists, libraryTracks, likedTracks,
  playlistDetail, playlistSummaries, searchFixtures, wantlist,
} from '@/fixtures/catalog'
import { useLogout } from '@/auth/actions'
import { useCurrentUser } from '@/auth/session'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { usePlayer } from '@/player/player-context'

function usePlayCollections() {
  const { controls } = usePlayer()
  const play = (tracks: TrackSummary[], context: Parameters<typeof controls.playTracks>[2]) => {
    const first = tracks.findIndex(track => track.availability !== 'none')
    if (first >= 0) controls.playTracks(tracks, first, context)
  }
  return {
    playAlbum: (album: AlbumSummary) => play(albumTracks(album.id), { type: 'album', id: album.id, title: album.title }),
    playPlaylist: (playlist: PlaylistSummary) => play(playlistDetail(playlist.id)?.items.map(item => item.track) ?? [], { type: 'playlist', id: playlist.id, title: playlist.name }),
  }
}

export function ShellPage() {
  const user = useCurrentUser()
  const logout = useLogout()
  const library = useLibrary()
  const likedCount = likedTracks.filter(track => library.isLiked(track.id, true)).length
  return (
    <AppShell
      user={user}
      onLogout={logout}
      playlists={playlistSummaries}
      likedCount={likedCount}
      onCreatePlaylist={request => toast({ title: 'Playlist created', description: request.name })}
    />
  )
}

export function HomePage() {
  const { playAlbum, playPlaylist } = usePlayCollections()
  return <HomeView featured={featuredAlbum} sections={home.sections} onPlayAlbum={playAlbum} onPlayPlaylist={playPlaylist} />
}

export function AlbumPage() {
  const album = albumDetail(useParams().id ?? '')
  return album ? <AlbumView key={album.id} album={album} /> : <NotFoundPage />
}

export function ArtistPage() {
  const { playAlbum } = usePlayCollections()
  const artist = artistDetail(useParams().id ?? '')
  return artist ? <ArtistView key={artist.id} artist={artist} onPlayAlbum={playAlbum} /> : <NotFoundPage />
}

export function PlaylistPage() {
  const playlist = playlistDetail(useParams().id ?? '')
  if (!playlist) return <NotFoundPage />
  return (
    <PlaylistView
      key={playlist.id}
      playlist={playlist}
      onRename={() => toast({ title: 'Editing playlists needs the server' })}
      onDelete={() => toast({ title: 'Deleting playlists needs the server' })}
    />
  )
}

export function LikedPage() {
  const library = useLibrary()
  return <LikedView tracks={likedTracks.filter(track => library.isLiked(track.id, true))} />
}

export function WantlistPage() {
  return <WantlistView albums={wantlist.albums} tracks={wantlist.tracks} />
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const { playAlbum } = usePlayCollections()
  const query = params.get('q') ?? ''
  // The catalog search goes to an outside provider, so it answers after the library does.
  const [settled, setSettled] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 450)
    return () => clearTimeout(timer)
  }, [query])
  const { library } = searchFixtures(query)
  const { catalog } = searchFixtures(settled)
  return (
    <SearchView
      query={query}
      onQueryChange={q => setParams(q ? { q } : {}, { replace: true })}
      library={query.trim() ? library : null}
      catalog={settled.trim() ? catalog : null}
      catalogLoading={settled !== query && query.trim().length > 0}
      genres={genres}
      onPlayAlbum={playAlbum}
    />
  )
}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** The server sorts with `?sort=`; the fixtures sort here. */
function useSort(): [LibrarySort, (sort: LibrarySort) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get('sort')
  const sort: LibrarySort = value === 'title' || value === 'artist' || value === 'year' ? value : 'recent'
  return [sort, next => setParams(next === 'recent' ? {} : { sort: next }, { replace: true })]
}

export function LibraryAlbumsPage() {
  const [sort, setSort] = useSort()
  const { playAlbum } = usePlayCollections()
  const albums = [...libraryAlbums].sort((a, b) =>
    sort === 'title' ? compare(a.title, b.title)
      : sort === 'artist' ? compare(a.artistCredit, b.artistCredit)
        : sort === 'year' ? (b.year ?? 0) - (a.year ?? 0) : 0)
  return <LibraryAlbumsView albums={albums} sort={sort} onSortChange={setSort} onPlayAlbum={playAlbum} />
}

export function LibraryArtistsPage() {
  const [sort, setSort] = useSort()
  const artists: ArtistSummary[] = sort === 'recent' ? libraryArtists : [...libraryArtists].sort((a, b) => compare(a.name, b.name))
  return <LibraryArtistsView artists={artists} sort={sort} onSortChange={setSort} />
}

export function LibrarySongsPage() {
  const [sort, setSort] = useSort()
  const tracks = [...libraryTracks].sort((a, b) =>
    sort === 'title' ? compare(a.title, b.title)
      : sort === 'artist' ? compare(a.artistCredit, b.artistCredit)
        : sort === 'year' ? compare(b.album?.title ?? '', a.album?.title ?? '') : 0)
  return <LibrarySongsView tracks={tracks} sort={sort} onSortChange={setSort} />
}

export function LibraryPlaylistsPage() {
  const { playPlaylist } = usePlayCollections()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <LibraryPlaylistsView playlists={playlistSummaries} onPlayPlaylist={playPlaylist} onCreate={() => setCreating(true)} />
      <CreatePlaylistDialog open={creating} onOpenChange={setCreating} onCreate={request => toast({ title: 'Playlist created', description: request.name })} />
    </>
  )
}

export function NotFoundPage() {
  return (
    <Page>
      <EmptyState icon={<Compass />} title="Nothing here" description="This page does not exist, or the music it pointed to is gone." action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>} />
    </Page>
  )
}
