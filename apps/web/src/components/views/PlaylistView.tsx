import type { PlaybackContext, PlaylistDetail, TrackSummary } from '@squirmy/contracts'
import { Globe, Heart, ListMusic, Lock, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { MoreFailure } from '@/api/queries'
import { LikedCover, likedTint, PlaylistCover } from '@/components/music/CollectionArt'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { TrackList, VirtualTrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { FormError } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { LoadError } from '@/components/ui/query-state'
import { isPlayable } from '@/lib/catalog'
import { formatTotalDuration, plural } from '@/lib/format'
import { useMediaQuery } from '@/lib/use-media-query'
import { usePlayerControls, type PlayOptions } from '@/player/player-context'
import { useViewer } from '@/player/on-demand-context'
import { useTrackActions } from '@/player/use-track-actions'

type PlaylistViewProps = {
  playlist: PlaylistDetail
  /** The owner's controls: edit, delete, reorder, remove. */
  owned: boolean
  onEdit: () => void
  /** Its menu entry waits for the server, and says on itself when it refused. */
  onTogglePublic: () => Promise<unknown>
  onDelete: () => void
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
  /** A move or removal the server refused, said above the songs it went back among. */
  failure?: string
}

export function PlaylistView({ playlist, owned, onEdit, onTogglePublic, onDelete, onMove, onRemove, failure }: PlaylistViewProps) {
  const tracks = playlist.items.map(item => item.track)
  // A finger cannot drag a song onto the sidebar (on a phone it is a drawer over the songs), so touch screens are told the menu's way.
  const touch = useMediaQuery('(pointer: coarse)')
  return (
    <TrackCollection
      kind={playlist.isPublic ? 'Public playlist' : 'Playlist'}
      title={playlist.name}
      art={<PlaylistCover artworks={playlist.artworks} />}
      tint={playlist.artworks[0]?.color}
      byline={<span className="text-muted-foreground">{playlist.ownerName}</span>}
      description={playlist.description}
      tracks={tracks}
      addedAt={playlist.items.map(item => item.addedAt)}
      durationMs={playlist.durationMs}
      context={{ type: 'playlist', id: playlist.id, title: playlist.name }}
      onMove={owned ? onMove : undefined}
      onRemove={owned ? onRemove : undefined}
      failure={failure}
      menu={owned && (
        <DropdownMenu
          align="start"
          entries={[
            { label: 'Edit details', icon: <Pencil />, onSelect: onEdit },
            playlist.isPublic
              ? { label: 'Make private', icon: <Lock />, onSelect: onTogglePublic }
              : { label: 'Make public', icon: <Globe />, onSelect: onTogglePublic },
            { kind: 'separator' },
            { label: 'Delete playlist', icon: <Trash2 />, danger: true, onSelect: onDelete },
          ]}
          trigger={<IconButton label="More options" size="lg"><MoreHorizontal /></IconButton>}
        />
      )}
      empty={(
        <EmptyState
          icon={<ListMusic />}
          title="This playlist is empty"
          description={!owned ? undefined
            : touch ? 'Add songs from any album, artist or search: open a song’s menu and choose Add to playlist.'
              : 'Add songs from any album, artist or search with the track menu, or drag them onto the playlist in the sidebar.'}
          action={owned && <Button asChild variant="primary"><Link to="/search">Find something</Link></Button>}
        />
      )}
    />
  )
}

type LikedViewProps = {
  tracks: TrackSummary[]
  /** Whether the list is complete; liked songs arrive a page at a time. */
  complete: boolean
  onEndReached: () => void
  /** The next page failed: the list stops there and offers to try again. */
  moreFailure?: MoreFailure
  /** Plays from a row once every song is loaded. */
  onPlay: (index: number, options?: PlayOptions) => void
}

export function LikedView({ tracks, complete, onEndReached, moreFailure, onPlay }: LikedViewProps) {
  return (
    <TrackCollection
      kind="Playlist"
      title="Liked Songs"
      art={<LikedCover />}
      tint={likedTint}
      tracks={tracks}
      count={complete ? undefined : `${tracks.length.toLocaleString()}+ songs`}
      durationMs={complete ? tracks.reduce((sum, track) => sum + track.durationMs, 0) : null}
      context={{ type: 'liked', id: null, title: 'Liked Songs' }}
      onPlay={onPlay}
      virtual={{ onEndReached, moreFailure }}
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
  /** Overrides "12 songs" while the list is still loading. */
  count?: string
  /** Null while unknown. */
  durationMs: number | null
  context: PlaybackContext
  /** Replaces playing `tracks` from a row, for lists that load the rest first. */
  onPlay?: (index: number, options?: PlayOptions) => void
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  /** Render only the rows near the viewport, loading more as the end comes into view, until a page fails. */
  virtual?: { onEndReached: () => void; moreFailure?: MoreFailure }
  menu?: ReactNode
  empty: ReactNode
  failure?: string
}

function TrackCollection({ kind, title, art, tint, byline, description, tracks, addedAt, count, durationMs, context, onPlay, onMove, onRemove, virtual, menu, empty, failure }: TrackCollectionProps) {
  const controls = usePlayerControls()
  const play = onPlay ?? ((index: number, options?: PlayOptions) => controls.playTracks(tracks, index, context, options))
  const actions = useTrackActions(tracks, context, { onPlay: index => play(index), onMove, onRemove })
  const viewer = useViewer()
  const playable = tracks.some(track => isPlayable(track, viewer))
  const size = tracks.length ? [count ?? plural(tracks.length, 'song'), durationMs !== null && formatTotalDuration(durationMs)].filter(Boolean).join(', ') : 'No songs yet'
  return (
    <div>
      <CollectionHeader
        kind={kind}
        title={title}
        art={art}
        tint={tint}
        byline={byline}
        meta={[size]}
        description={description}
        actions={(
          <PlayActions
            title={title}
            onPlay={playable ? () => play(0, { collection: true }) : undefined}
            onShuffle={playable ? () => play(0, { shuffle: true, collection: true }) : undefined}
          >
            {menu}
          </PlayActions>
        )}
      />
      <div className="px-(--gutter) pb-10">
        {failure && <div className="mb-3"><FormError message={failure} /></div>}
        {!tracks.length
          ? empty
          : virtual
            ? <div className="-mx-2"><VirtualTrackList label={`${title} tracks`} tracks={tracks} variant="playlist" onEndReached={virtual.onEndReached} {...actions} /></div>
            : <div className="-mx-2"><TrackList label={`${title} tracks`} tracks={tracks} addedAt={addedAt} variant="playlist" {...actions} /></div>}
        {virtual?.moreFailure && <LoadError title="More songs didn’t load" {...virtual.moreFailure} className="mt-4" />}
      </div>
    </div>
  )
}
