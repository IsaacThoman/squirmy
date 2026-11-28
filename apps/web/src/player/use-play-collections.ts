import type { AlbumSummary, PlaybackContext, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { errorMessage } from '@/api/errors'
import { albumQuery, artistQuery, loadItems, playlistQuery, type PagedResult } from '@/api/queries'
import { useApi } from '@/api/services'
import { usePlayerControls, type PlayOptions, type StatusMessage } from './player-context'

/** Play could not load the rest of a long list, and played the songs it had, as the iOS app says. */
export const incompleteList: StatusMessage = { message: 'Couldn’t load the whole list', detail: 'Playing the songs loaded so far.', tone: 'error' }

/**
 * Play buttons on cards and sidebar rows: the album or playlist is fetched (or read from the
 * cache) first. One that does not load says so on the player's status line, as any command to
 * play does.
 */
export function usePlayCollections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const controls = usePlayerControls()
  const play = async <T,>(name: string, query: { queryKey: QueryKey; queryFn: () => Promise<T> }, tracks: (data: T) => TrackSummary[], context: (data: T) => PlaybackContext, options?: PlayOptions) => {
    try {
      const data = await queryClient.fetchQuery(query)
      controls.playTracks(tracks(data), 0, context(data), { ...options, collection: true })
    } catch (error) {
      controls.tell({ message: `Couldn’t play “${name}”`, detail: errorMessage(error), tone: 'error' })
    }
  }
  return {
    /**
     * Plays a list loaded page by page (Liked Songs, the library's songs) once up to `limit` of
     * it is loaded. When a page fails it plays what was loaded and says so on the status line.
     */
    playLoaded: async (list: PagedResult<TrackSummary>, limit: number, play: (tracks: TrackSummary[]) => void) => {
      const { items, complete } = await loadItems(list, limit)
      play(items)
      if (!complete) controls.tell(incompleteList)
    },
    playArtist: (artist: { id: string; name: string }) => play(artist.name, artistQuery(api, artist.id),
      detail => detail.topTracks, detail => ({ type: 'artist', id: detail.id, title: detail.name })),
    playAlbum: (album: AlbumSummary, options?: PlayOptions) => play(album.title, albumQuery(api, album.id), detail => detail.discs.flatMap(disc => disc.tracks), detail => ({ type: 'album', id: detail.id, title: detail.title }), options),
    playPlaylist: (playlist: PlaylistSummary) => play(playlist.name, playlistQuery(api, playlist.id), detail => detail.items.map(item => item.track), detail => ({ type: 'playlist', id: detail.id, title: detail.name })),
  }
}
