import type { TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { albumQuery, playlistQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import type { MusicDrag } from '@/lib/drag'

/**
 * The songs of what was dropped: the dragged songs themselves, or the album's or playlist's,
 * loaded (from the cache when its card was hovered) once it lands. Rejects when they do not
 * load, for the drop target to say so.
 */
export function useDroppedMusic() {
  const api = useApi()
  const queryClient = useQueryClient()
  return async (music: MusicDrag): Promise<TrackSummary[]> => {
    if (music.kind === 'tracks') return music.drag.tracks
    const { kind, id } = music.collection
    if (kind === 'album') {
      const album = await queryClient.fetchQuery(albumQuery(api, id))
      return album.discs.flatMap(disc => disc.tracks)
    }
    const playlist = await queryClient.fetchQuery(playlistQuery(api, id))
    return playlist.items.map(item => item.track)
  }
}
