import type { SearchItem } from '@squirmy/client-core'
import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { BookmarkCheck, BookmarkPlus, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, Play, Plus, Radio } from 'lucide-react'
import { useNavigate } from 'react-router'
import { errorMessage } from '@/api/errors'
import { albumQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import type { MenuEntry } from '@/components/ui/menu'
import { librarySaveEntry } from './library-save-entry'
import { albumPresentation, isPlayable } from '@/lib/catalog'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { usePlayCollections } from '@/player/use-play-collections'

/**
 * Menus for an album, an artist or a playlist shown as a row (search results), with what
 * their pages' menus offer that needs no more than the row, the heart's Save to library or
 * Remove from library included: an album's songs are fetched when an entry needs them. Songs
 * use `trackMenuEntries`. Playlists are the viewer's own, so there is nothing to save.
 */
export function useResultMenus() {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const controls = usePlayerControls()
  const library = useLibrary()
  const viewer = useViewer()
  const { playAlbum, playPlaylist } = usePlayCollections()

  const withTracks = (album: AlbumSummary, use: (tracks: TrackSummary[]) => void) => {
    queryClient.fetchQuery(albumQuery(api, album.id))
      .then(detail => use(detail.discs.flatMap(disc => disc.tracks)))
      .catch((error: unknown) => toast({ title: errorMessage(error) }))
  }
  const enqueue = (album: AlbumSummary, placement: 'next' | 'last') => withTracks(album, tracks => {
    const playable = tracks.filter(track => isPlayable(track, viewer))
    if (!playable.length) return
    controls.enqueue(playable, placement)
    toast({ title: placement === 'next' ? 'Playing next' : 'Added to queue', description: album.title })
  })

  return (item: Exclude<SearchItem, { type: 'track' }>): MenuEntry[] => {
    if (item.type === 'artist') {
      const { artist } = item
      const save = artist.liked === undefined ? [] : [librarySaveEntry({ liked: artist.liked }, () => library.setSaved({ type: 'artist', id: artist.id, title: artist.name }, !artist.liked))]
      return [
        { label: 'Start radio', icon: <Radio />, onSelect: () => controls.startRadio({ type: 'artist', id: artist.id }) },
        ...save,
        { kind: 'separator' },
        { label: 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) },
      ]
    }
    if (item.type === 'playlist') {
      const { playlist } = item
      return [
        { label: 'Play', icon: <Play />, disabled: playlist.trackCount === 0, onSelect: () => void playPlaylist(playlist) },
        { kind: 'separator' },
        { label: 'Go to playlist', icon: <ListMusic />, onSelect: () => navigate(`/playlist/${playlist.id}`) },
      ]
    }
    const { album } = item
    const plays = albumPresentation(album, viewer) === 'normal'
    const wanted = library.isWanted(album.id)
    const want = () => {
      library.setWanted({ type: 'album', album }, !wanted)
      toast({ title: wanted ? 'Removed from Wantlist' : 'Added to Wantlist', description: album.title })
    }
    return [
      { label: 'Play', icon: <Play />, disabled: !plays, onSelect: () => void playAlbum(album) },
      { label: 'Play next', icon: <ListStart />, disabled: !plays, onSelect: () => enqueue(album, 'next') },
      { label: 'Add to queue', icon: <ListEnd />, disabled: !plays, onSelect: () => enqueue(album, 'last') },
      {
        kind: 'submenu',
        label: 'Add to playlist',
        icon: <ListPlus />,
        items: [
          { label: 'New playlist…', icon: <Plus />, onSelect: () => withTracks(album, tracks => library.newPlaylist(tracks)) },
          ...(library.playlists.length ? [{ kind: 'separator' as const }] : []),
          ...library.playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => withTracks(album, tracks => library.addToPlaylist(playlist, tracks)) })),
        ],
      },
      // The heart's entry, as on the album page; an answer from an older server says nothing to show.
      ...(album.liked === undefined ? [] : [librarySaveEntry({ liked: album.liked }, () => library.setSaved({ type: 'album', id: album.id, title: album.title }, !album.liked))]),
      // The Wantlist is for music that does not play, while the server has it on.
      ...(library.wantlistEnabled && !plays ? [{ label: wanted ? 'Remove from Wantlist' : 'Add to Wantlist', icon: wanted ? <BookmarkCheck /> : <BookmarkPlus />, onSelect: want }] : []),
      { kind: 'separator' },
      { label: 'Go to album', icon: <Disc3 />, onSelect: () => navigate(`/album/${album.id}`) },
      ...album.artists.map(artist => ({ label: album.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
    ]
  }
}
