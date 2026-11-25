import type { SearchItem } from '@squirmy/client-core'
import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ListMusic, MicVocal, Play, Radio } from 'lucide-react'
import { useNavigate } from 'react-router'
import { albumQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import type { MenuEntry } from '@/components/ui/menu'
import { albumMenuEntries } from './album-menu'
import { librarySaveEntry } from './library-save-entry'
import { albumPresentation, isPlayable } from '@/lib/catalog'
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

  // The entry waits for the album's songs, and says on itself when they did not load.
  const withTracks = <T,>(album: AlbumSummary, use: (tracks: TrackSummary[]) => T) =>
    queryClient.fetchQuery(albumQuery(api, album.id)).then(detail => use(detail.discs.flatMap(disc => disc.tracks)))
  // Nothing that plays: nothing is queued, and the entry closes without saying it was.
  const enqueue = (album: AlbumSummary, placement: 'next' | 'last') => withTracks(album, tracks => {
    const playable = tracks.filter(track => isPlayable(track, viewer))
    if (!playable.length) return false
    controls.enqueue(playable, placement)
    return true
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
    const want = () => library.setWanted({ type: 'album', album }, !wanted)
    // The album's own menu, as on its page and its cards, with the saved state the search answer carries.
    return albumMenuEntries({
      artists: album.artists,
      playable: plays,
      onPlay: () => void playAlbum(album),
      onShuffle: () => void playAlbum(album, { shuffle: true }),
      onEnqueue: placement => enqueue(album, placement),
      playlists: library.playlists,
      onAddToPlaylist: playlist => withTracks(album, tracks => {
        if (playlist) return library.addToPlaylist(playlist, tracks)
        library.newPlaylist(tracks)
        return false
      }),
      liked: album.liked,
      onToggleSaved: () => library.setSaved({ type: 'album', id: album.id, title: album.title }, !album.liked),
      // The Wantlist is for music that does not play, while the server has it on.
      want: library.wantlistEnabled && !plays ? { wanted, onToggle: want } : undefined,
      onGoToArtist: artist => navigate(`/artist/${artist.id}`),
    })
  }
}
