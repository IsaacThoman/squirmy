import type { AlbumSummary, PlaybackContext, TrackSummary } from '@squirmy/contracts'
import type { TrackAction } from '@/components/music/TrackList'
import type { BatchAction, TrackBatch } from '@/components/music/track-selection'
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
  /** Removes several rows at once; without it they go one by one through `onRemove`. */
  onRemoveMany?: (indexes: number[]) => void | Promise<unknown>
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
    } else if (action === 'share') {
      library.share({ kind: 'track', id: track.id, albumId: track.album?.id ?? null, title: track.title })
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

  // Several picked rows at once. Saving waits for every save, for the bar to say how it went.
  const act = (action: BatchAction, indexes: number[]): void | Promise<unknown> => {
    const picked = indexes.flatMap(index => (tracks[index] ? [tracks[index]] : []))
    if (!picked.length) return
    if (action === 'play') return controls.playTracks(picked, 0, context)
    if (action === 'play-next' || action === 'enqueue') return controls.enqueue(picked, action === 'play-next' ? 'next' : 'last')
    if (action === 'save' || action === 'unsave') {
      const saved = action === 'save'
      return Promise.all(picked.filter(track => track.liked !== saved).map(track => library.setSaved({ type: 'track', id: track.id, title: track.title }, saved)))
    }
    if (action === 'remove') {
      if (options.onRemoveMany) return options.onRemoveMany(indexes)
      // From the last, so the indexes before it still point where they did.
      for (const index of [...indexes].sort((a, b) => b - a)) options.onRemove?.(index)
      return
    }
    const playlistId = action.slice('add-to:'.length)
    const playlist = library.playlists.find(candidate => candidate.id === playlistId)
    if (playlistId === 'new') library.newPlaylist(picked)
    else if (playlist) return library.addToPlaylist(playlist, picked)
  }
  const batch: TrackBatch = { act, playlists: library.playlists, remove: options.onRemove ? 'playlist' : undefined }

  return {
    batch,
    isWanted: library.wantlistEnabled ? (track: TrackSummary) => library.isWanted(track.id) : undefined,
    playlists: library.playlists,
    canShare: library.sharingEnabled,
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
