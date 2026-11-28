import type { MixSummary, TrackSummary } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { mixQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import type { CardMenu } from '@/components/music/Cards'
import { mixMenuEntries } from '@/components/music/mix-menu'
import { useLibrary } from './library-context'
import { usePlayCollections } from './use-play-collections'

/** A mix card's menu: the mix page's, loading the mix's songs (from the cache when it was opened) for what needs them. */
export function useMixMenu(mix: MixSummary): CardMenu {
  const api = useApi()
  const queryClient = useQueryClient()
  const library = useLibrary()
  const { playMix, enqueueMix } = usePlayCollections()
  const withTracks = async <T,>(then: (tracks: TrackSummary[]) => T) => then((await queryClient.fetchQuery(mixQuery(api, mix.id))).tracks)
  return {
    entries: mixMenuEntries({
      onPlay: () => void playMix(mix),
      onShuffle: () => void playMix(mix, { shuffle: true }),
      onEnqueue: placement => enqueueMix(mix, placement),
      playlists: library.playlists,
      onAddToPlaylist: playlist => withTracks(tracks => {
        if (playlist) return library.addToPlaylist(playlist, tracks)
        library.newPlaylist(tracks)
        return false
      }),
    }),
  }
}
