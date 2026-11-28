import type { TrackSummary } from '@squirmy/contracts'
import { useNavigate } from 'react-router'
import { trackMenuEntries } from '@/components/music/track-menu'
import type { TrackAction } from '@/components/music/TrackList'
import type { MenuEntry } from '@/components/ui/menu'
import { isPlayable } from '@/lib/catalog'
import { useViewer } from '@/player/on-demand-context'
import { useJamRights, usePlayerControls } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

const noTracks: TrackSummary[] = []

export type SongMenuOptions = {
  track: TrackSummary
  /** The entry could not be had: the song does not play from here, though its menu still saves it and goes to it. */
  unavailable?: boolean
  /** An Up next entry: Play next and Move to end move it in the queue (`TrackMenuOptions.queued`). */
  queued?: { entryId: string; index: number; count: number }
  /** Before going to the song's album or artist, as Now Playing closes over the page. */
  onNavigate?: () => void
  /** Entries after the song's own, for where it plays: Track info in Now Playing. */
  extraMenu?: MenuEntry[]
}

/**
 * The song's menu where it plays or waits to: Now Playing, the player and the queue. It is the
 * menu a song has in any list, as the iOS app has it there too: the queue, a playlist, radio,
 * the library and the song's album and artists. Built when asked, so a row that never opens it
 * builds nothing.
 */
export function useSongMenuEntries({ track, unavailable = false, queued, onNavigate, extraMenu }: SongMenuOptions): () => MenuEntry[] {
  const navigate = useNavigate()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const actions = useTrackActions(noTracks)
  const rights = useJamRights()
  const act = (action: TrackAction) => {
    if (queued && (action === 'play-next' || action === 'enqueue')) return controls.moveEntry(queued.entryId, action === 'play-next' ? 0 : queued.count - 1)
    return actions.onAction(action, track, 0)
  }
  return () => trackMenuEntries(track, {
    unavailable: unavailable || !isPlayable(track, viewer),
    wanted: actions.isWanted?.(track),
    playlists: actions.playlists,
    ratings: actions.ratings,
    act,
    navigate: to => {
      onNavigate?.()
      void navigate(to)
    },
    queued: queued && { index: queued.index, count: queued.count },
    extraMenu,
    rights,
  })
}
