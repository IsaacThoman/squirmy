import type { TrackSummary } from '@squirmy/contracts'
import { MoreHorizontal } from 'lucide-react'
import { useNavigate } from 'react-router'
import { trackMenuEntries } from '@/components/music/track-menu'
import type { TrackAction } from '@/components/music/TrackList'
import { IconButton, type IconButtonProps } from '@/components/ui/icon-button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { isPlayable } from '@/lib/catalog'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

const noTracks: TrackSummary[] = []

type SongMenuButtonProps = {
  track: TrackSummary
  /** The entry could not be had: the song does not play from here, though its menu still saves it and goes to it. */
  unavailable?: boolean
  /** An Up next entry: Play next and Move to end move it in the queue (`TrackMenuOptions.queued`). */
  queued?: { entryId: string; index: number; count: number }
  /** Before going to the song's album or artist, as Now Playing closes over the page. */
  onNavigate?: () => void
  /** Entries after the song's own, for where it plays: Track info in Now Playing. */
  extraMenu?: MenuEntry[]
  size?: IconButtonProps['size']
  className?: string
}

/**
 * The song's menu where it plays or waits to: Now Playing and the queue. It is the menu a song
 * has in any list, as the iOS app has it there too: the queue, a playlist, radio, the library
 * and the song's album and artists.
 */
export function SongMenuButton({ track, unavailable = false, queued, onNavigate, extraMenu, size = 'sm', className }: SongMenuButtonProps) {
  const navigate = useNavigate()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const actions = useTrackActions(noTracks)
  const act = (action: TrackAction) => {
    if (queued && (action === 'play-next' || action === 'enqueue')) return controls.moveEntry(queued.entryId, action === 'play-next' ? 0 : queued.count - 1)
    return actions.onAction(action, track, 0)
  }
  const entries = trackMenuEntries(track, {
    unavailable: unavailable || !isPlayable(track, viewer),
    wanted: actions.isWanted?.(track),
    playlists: actions.playlists,
    act,
    navigate: to => {
      onNavigate?.()
      void navigate(to)
    },
    queued: queued && { index: queued.index, count: queued.count },
    extraMenu,
  })
  return (
    <DropdownMenu
      entries={entries}
      trigger={<IconButton label={`More options for ${track.title}`} tooltip={false} size={size} className={className}><MoreHorizontal /></IconButton>}
    />
  )
}
