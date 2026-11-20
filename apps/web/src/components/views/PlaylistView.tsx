import type { PlaybackContext, PlaylistDetail, TrackSummary } from '@squirmy/contracts'
import { Heart, ListMusic, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { LikedCover, PlaylistCover } from '@/components/music/CollectionArt'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { formatTotalDuration, plural } from '@/lib/format'
import { usePlayer } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

type PlaylistViewProps = {
  playlist: PlaylistDetail
  onRename: () => void
  onDelete: () => void
}

export function PlaylistView({ playlist, onRename, onDelete }: PlaylistViewProps) {
  const tracks = playlist.items.map(item => item.track)
  return (
    <TrackCollection
      kind={playlist.isPublic ? 'Public playlist' : 'Playlist'}
      title={playlist.name}
      art={<PlaylistCover artworks={playlist.artworks} />}
      tint={playlist.artworks[0]?.color}
      byline={<span className="text-muted">{playlist.ownerName}</span>}
      description={playlist.description}
      tracks={tracks}
      addedAt={playlist.items.map(item => item.addedAt)}
      durationMs={playlist.durationMs}
      context={{ type: 'playlist', id: playlist.id, title: playlist.name }}
      menu={(
        <DropdownMenu
          align="start"
          entries={[
            { label: 'Edit details', icon: <Pencil />, onSelect: onRename },
            { kind: 'separator' },
            { label: 'Delete playlist', icon: <Trash2 />, danger: true, onSelect: onDelete },
          ]}
          trigger={<IconButton label="More options" size="lg"><MoreHorizontal /></IconButton>}
        />
      )}
      empty={<EmptyState icon={<ListMusic />} title="This playlist is empty" description="Add songs from any album, artist or search with the track menu." action={<Button asChild variant="primary"><Link to="/search">Find something</Link></Button>} />}
    />
  )
}

export function LikedView({ tracks }: { tracks: TrackSummary[] }) {
  return (
    <TrackCollection
      kind="Playlist"
      title="Liked Songs"
      art={<LikedCover />}
      tint="#7862B4"
      tracks={tracks}
      durationMs={tracks.reduce((sum, track) => sum + track.durationMs, 0)}
      context={{ type: 'liked', id: null, title: 'Liked Songs' }}
      empty={<EmptyState icon={<Heart />} title="Songs you like appear here" description="Tap the heart next to any song to save it." />}
    />
  )
}

type TrackCollectionProps = {
  kind: string
  title: string
  art: ReactNode
  tint?: string | null
  byline?: ReactNode
  description?: string | null
  tracks: TrackSummary[]
  addedAt?: string[]
  durationMs: number
  context: PlaybackContext
  menu?: ReactNode
  empty: ReactNode
}

function TrackCollection({ kind, title, art, tint, byline, description, tracks, addedAt, durationMs, context, menu, empty }: TrackCollectionProps) {
  const { controls } = usePlayer()
  const actions = useTrackActions(tracks, context)
  const first = tracks.findIndex(track => track.availability !== 'none')
  return (
    <div>
      <CollectionHeader
        kind={kind}
        title={title}
        art={art}
        tint={tint}
        byline={byline}
        meta={[tracks.length ? `${plural(tracks.length, 'song')}, ${formatTotalDuration(durationMs)}` : 'No songs yet']}
        actions={(
          <PlayActions
            title={title}
            onPlay={first >= 0 ? () => actions.onPlay(first) : undefined}
            onShuffle={first >= 0 ? () => {
              controls.setShuffle(true)
              actions.onPlay(first)
            } : undefined}
          >
            {menu}
          </PlayActions>
        )}
      />
      <div className="px-(--gutter) pb-12">
        {description && <p className="-mt-2 mb-6 max-w-3xl text-[15px] leading-relaxed text-muted">{description}</p>}
        {tracks.length ? <TrackList label={`${title} tracks`} tracks={tracks} addedAt={addedAt} variant="playlist" {...actions} /> : empty}
      </div>
    </div>
  )
}
