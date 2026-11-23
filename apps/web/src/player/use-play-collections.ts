import type { AlbumSummary, PlaybackContext, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { errorMessage } from '@/api/errors'
import { albumQuery, playlistQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import { usePlayerControls } from './player-context'

/**
 * Play buttons on cards and sidebar rows: the album or playlist is fetched (or read from the
 * cache) first. One that does not load says so on the player's status line, as any command to
 * play does.
 */
export function usePlayCollections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const controls = usePlayerControls()
  const play = async <T,>(name: string, query: { queryKey: QueryKey; queryFn: () => Promise<T> }, tracks: (data: T) => TrackSummary[], context: (data: T) => PlaybackContext) => {
    try {
      const data = await queryClient.fetchQuery(query)
      controls.playTracks(tracks(data), 0, context(data), { collection: true })
    } catch (error) {
      controls.tell({ message: `Couldn’t play “${name}”`, detail: errorMessage(error), tone: 'error' })
    }
  }
  return {
    playAlbum: (album: AlbumSummary) => play(album.title, albumQuery(api, album.id), detail => detail.discs.flatMap(disc => disc.tracks), detail => ({ type: 'album', id: detail.id, title: detail.title })),
    playPlaylist: (playlist: PlaylistSummary) => play(playlist.name, playlistQuery(api, playlist.id), detail => detail.items.map(item => item.track), detail => ({ type: 'playlist', id: detail.id, title: detail.name })),
  }
}
