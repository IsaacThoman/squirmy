import type { PlaybackContext, TrackSummary } from '@squirmy/contracts'
import { useMemo } from 'react'
import type { NowPlaying, TrackAction } from '@/components/music/TrackList'
import { toast } from '@/lib/toast'
import { useLibrary } from './library-context'
import { usePlayer } from './player-context'

/** What a track list needs from the session and the library: the playing row and its actions. */
export function useTrackActions(tracks: TrackSummary[], context?: PlaybackContext) {
  const { state, controls } = usePlayer()
  const library = useLibrary()
  const current = state.current

  const nowPlaying = useMemo<NowPlaying | null>(() => current && {
    trackId: current.track.id,
    playing: state.playing,
    preparing: current.entry.state === 'preparing',
    onTogglePlay: controls.togglePlay,
  }, [current, state.playing, controls])

  return {
    nowPlaying,
    isLiked: (track: TrackSummary) => library.isLiked(track.id, track.liked),
    isWanted: (track: TrackSummary) => library.isWanted(track.id, false),
    onPlay: (index: number) => controls.playTracks(tracks, index, context),
    onAction: (action: TrackAction, track: TrackSummary) => {
      if (action === 'play-next' || action === 'enqueue') {
        controls.enqueue([track], action === 'play-next' ? 'next' : 'last')
        toast({ title: action === 'play-next' ? 'Playing next' : 'Added to queue', description: track.title })
      } else if (action === 'like') {
        const liked = !library.isLiked(track.id, track.liked)
        library.setLiked('track', track.id, liked)
        toast({ title: liked ? 'Saved to Liked Songs' : 'Removed from Liked Songs', description: track.title })
      } else if (action === 'want') {
        const wanted = !library.isWanted(track.id, false)
        library.setWanted('track', track.id, wanted)
        toast({ title: wanted ? 'Added to Wantlist' : 'Removed from Wantlist', description: track.title })
      } else {
        toast({ title: 'Removed from playlist', description: track.title })
      }
    },
  }
}
