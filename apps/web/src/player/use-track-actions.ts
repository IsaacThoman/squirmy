import type { AlbumSummary, PlaybackContext, TrackSummary } from '@squirmy/contracts'
import { useMemo } from 'react'
import type { NowPlaying, TrackAction } from '@/components/music/TrackList'
import { toast } from '@/lib/toast'
import { useLibrary } from './library-context'
import { usePlayer } from './player-context'

type TrackActionOptions = {
  /** Plays from a row; defaults to playing `tracks` from that row on. */
  onPlay?: (index: number) => void
  /** Rows that may be moved and removed (a playlist the user owns). */
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
}

/** What a track list needs from the session and the library: the playing row and its actions. */
export function useTrackActions(tracks: TrackSummary[], context?: PlaybackContext, options: TrackActionOptions = {}) {
  const { state, controls } = usePlayer()
  const library = useLibrary()
  const current = state.current

  const nowPlaying = useMemo<NowPlaying | null>(() => current && {
    trackId: current.track.id,
    playing: state.playing,
    preparing: current.entry.state === 'preparing',
    onTogglePlay: controls.togglePlay,
  }, [current, state.playing, controls])

  const onAction = (action: TrackAction, track: TrackSummary, index: number) => {
    if (action === 'play-next' || action === 'enqueue') {
      controls.enqueue([track], action === 'play-next' ? 'next' : 'last')
      toast({ title: action === 'play-next' ? 'Playing next' : 'Added to queue', description: track.title })
    } else if (action === 'like') {
      library.setLiked('track', track.id, !track.liked)
      toast({ title: track.liked ? 'Removed from Liked Songs' : 'Saved to Liked Songs', description: track.title })
    } else if (action === 'want') {
      const wanted = !library.isWanted(track.id)
      library.setWanted({ type: 'track', track }, wanted)
      toast({ title: wanted ? 'Added to Wantlist' : 'Removed from Wantlist', description: track.title })
    } else if (action === 'radio') {
      controls.startRadio({ type: 'track', id: track.id })
    } else if (action === 'remove') {
      options.onRemove?.(index)
    } else if (action === 'move-up' || action === 'move-down') {
      options.onMove?.(index, action === 'move-up' ? index - 1 : index + 1)
    } else {
      const playlistId = action.slice('add-to:'.length)
      const playlist = library.playlists.find(candidate => candidate.id === playlistId)
      if (playlistId === 'new') library.newPlaylist([track])
      else if (playlist) library.addToPlaylist(playlist, [track])
    }
  }

  return {
    nowPlaying,
    isWanted: (track: TrackSummary) => library.isWanted(track.id),
    playlists: library.playlists,
    onPlay: options.onPlay ?? ((index: number) => controls.playTracks(tracks, index, context)),
    onMove: options.onMove,
    onAction,
  }
}

/** Props for album cards that offer music you do not have to the Wantlist. */
export function useAlbumWants() {
  const library = useLibrary()
  return (album: AlbumSummary) => ({
    wanted: library.isWanted(album.id),
    onWant: (wanted: boolean) => {
      library.setWanted({ type: 'album', album }, wanted)
      toast({ title: wanted ? 'Added to Wantlist' : 'Removed from Wantlist', description: album.title })
    },
  })
}
