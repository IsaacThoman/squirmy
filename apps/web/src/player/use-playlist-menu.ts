import type { PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { playlistQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import { playlistMenuEntries } from '@/components/music/album-menu'
import { isPlayable } from '@/lib/catalog'
import { useLibrary } from './library-context'
import { useViewer } from './on-demand-context'
import { usePlayerControls } from './player-context'
import { usePlayCollections } from './use-play-collections'

/**
 * A playlist card's menu, from a right-click: play it, queue it, add its songs to another
 * playlist, or open it. What needs the songs loads the playlist first, and says on the entry
 * when it did not load.
 */
export function usePlaylistMenu(playlist: PlaylistSummary, onPlay?: () => void) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const library = useLibrary()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const { playPlaylist } = usePlayCollections()
  const withTracks = async <T,>(then: (tracks: TrackSummary[]) => T) => {
    const loaded = await queryClient.fetchQuery(playlistQuery(api, playlist.id))
    return then(loaded.items.map(item => item.track))
  }
  const entries = playlistMenuEntries({
    empty: playlist.trackCount === 0,
    onPlay: onPlay ?? (() => void playPlaylist(playlist)),
    // Nothing that plays: nothing is queued, and the entry closes without saying it was.
    onEnqueue: placement => withTracks(tracks => {
      const playable = tracks.filter(track => isPlayable(track, viewer))
      if (!playable.length) return false
      controls.enqueue(playable, placement)
      return true
    }),
    playlists: library.playlists.filter(other => other.id !== playlist.id),
    onAddToPlaylist: other => withTracks(tracks => {
      if (other) return library.addToPlaylist(other, tracks)
      library.newPlaylist(tracks)
      return false
    }),
    onOpen: () => void navigate(`/playlist/${playlist.id}`),
  })
  return { entries }
}
