import type { AlbumSummary, PlaybackContext, TrackSummary } from '@squirmy/contracts'
import type { TrackAction } from '@/components/music/TrackList'
import { albumPresentation } from '@/lib/catalog'
import { useLibrary } from './library-context'
import { useViewer } from './on-demand-context'
import { usePlayerControls } from './player-context'

type TrackActionOptions = {
  /** Plays from a row; defaults to playing `tracks` from that row on. */
  onPlay?: (index: number) => void
  /** Rows that may be moved and removed (a playlist the user owns). */
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
}

/**
 * What a track list needs from the player and the library: its rows' actions. It reads only the
 * player's commands, so the list does not render again as the session changes; each row follows
 * whether it is the current track itself (`useTrackPlayback`).
 */
export function useTrackActions(tracks: TrackSummary[], context?: PlaybackContext, options: TrackActionOptions = {}) {
  const controls = usePlayerControls()
  const library = useLibrary()

  // The menu entries say what worked, and wait for what the server answers (a save, a playlist) to say why it did not.
  const onAction = (action: TrackAction, track: TrackSummary, index: number): void | Promise<unknown> => {
    if (action === 'play-next' || action === 'enqueue') {
      controls.enqueue([track], action === 'play-next' ? 'next' : 'last')
    } else if (action === 'like') {
      return library.setSaved({ type: 'track', id: track.id, title: track.title }, !track.liked)
    } else if (action === 'want') {
      return library.setWanted({ type: 'track', track }, !library.isWanted(track.id))
    } else if (action === 'radio') {
      controls.startRadio({ type: 'track', id: track.id })
    } else if (action === 'sonic-radio') {
      controls.startRadio({ type: 'sonic', id: track.id })
    } else if (action === 'remove') {
      options.onRemove?.(index)
    } else if (action === 'move-up' || action === 'move-down') {
      options.onMove?.(index, action === 'move-up' ? index - 1 : index + 1)
    } else if (action.startsWith('rate:')) {
      return library.setRating(track, Number(action.slice('rate:'.length)))
    } else {
      const playlistId = action.slice('add-to:'.length)
      const playlist = library.playlists.find(candidate => candidate.id === playlistId)
      if (playlistId === 'new') library.newPlaylist([track])
      else if (playlist) return library.addToPlaylist(playlist, [track])
    }
  }

  return {
    isWanted: library.wantlistEnabled ? (track: TrackSummary) => library.isWanted(track.id) : undefined,
    playlists: library.playlists,
    ratings: library.showRatings,
    onPlay: options.onPlay ?? ((index: number) => controls.playTracks(tracks, index, context)),
    onMove: options.onMove,
    onAction,
  }
}

/**
 * Props for album cards that offer music that does not play to the Wantlist; none while the
 * server has it off, and none for what plays (for a requester, nearly everything).
 */
export function useAlbumWants() {
  const library = useLibrary()
  const viewer = useViewer()
  return (album: AlbumSummary): { wanted?: boolean; onWant?: (wanted: boolean) => void } => (!library.wantlistEnabled || albumPresentation(album, viewer) !== 'dimmed' ? {} : {
    wanted: library.isWanted(album.id),
    // The bookmark shows the change, and says so beside itself when the server refuses it.
    onWant: (wanted: boolean) => void library.setWanted({ type: 'album', album }, wanted),
  })
}
