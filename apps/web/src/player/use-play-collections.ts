import type { AlbumSummary, PlaybackContext, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { errorMessage } from '@/api/errors'
import { albumQuery, playlistQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import { toast } from '@/lib/toast'
import { usePlayerControls } from './player-context'

/** Play buttons on cards and sidebar rows: the album or playlist is fetched (or read from the cache) first. */
export function usePlayCollections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const controls = usePlayerControls()
  const play = async <T,>(query: { queryKey: QueryKey; queryFn: () => Promise<T> }, tracks: (data: T) => TrackSummary[], context: (data: T) => PlaybackContext) => {
    try {
      const data = await queryClient.fetchQuery(query)
      controls.playTracks(tracks(data), 0, context(data))
    } catch (error) {
      toast({ title: errorMessage(error) })
    }
  }
  return {
    playAlbum: (album: AlbumSummary) => play(albumQuery(api, album.id), detail => detail.discs.flatMap(disc => disc.tracks), detail => ({ type: 'album', id: detail.id, title: detail.title })),
    playPlaylist: (playlist: PlaylistSummary) => play(playlistQuery(api, playlist.id), detail => detail.items.map(item => item.track), detail => ({ type: 'playlist', id: detail.id, title: detail.name })),
  }
}
