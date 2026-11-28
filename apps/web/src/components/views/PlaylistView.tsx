import type { MixDetail, PlaybackContext, PlaylistDetail, TrackSummary } from '@squirmy/contracts'
import { AudioLines, Globe, Heart, ListMusic, Lock, MoreHorizontal, Pencil, Play, SearchX, Shuffle, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { MoreFailure } from '@/api/queries'
import { LikedCover, likedTint, MixCover, PlaylistCover } from '@/components/music/CollectionArt'
import { mixSlot } from '@/components/music/mix-menu'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { VirtualTrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { FormError } from '@/components/ui/input'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { LoadError } from '@/components/ui/query-state'
import { SearchField } from '@/components/ui/search-field'
import { Select } from '@/components/ui/select'
import { isPlayable } from '@/lib/catalog'
import { formatTotalDuration, plural } from '@/lib/format'
import { useMediaQuery } from '@/lib/use-media-query'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls, type PlayOptions } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'
import { playlistOrder, playlistSortOptions, type PlaylistSort } from './playlist-order'

type PlaylistViewProps = {
  playlist: PlaylistDetail
  /** The owner's controls: edit, delete, reorder, remove. A smart playlist's songs come from its rules, so they are never moved or removed. */
  owned: boolean
  /** Edits the details, and a smart playlist's rules. */
  onEdit: () => void
  /** Its menu entry waits for the server, and says on itself when it refused. */
  onTogglePublic: () => Promise<unknown>
  onDelete: () => void
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
  /** Removes the picked songs. */
  onRemoveMany: (indexes: number[]) => Promise<unknown>
  /** A move or removal the server refused, said above the songs it went back among. */
  failure?: string
}

export function PlaylistView({ playlist, owned, onEdit, onTogglePublic, onDelete, onMove, onRemove, onRemoveMany, failure }: PlaylistViewProps) {
  // Finding and sorting only change what is listed here: the playlist keeps its own order.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<PlaylistSort>('custom')
  const shown = useMemo(() => playlistOrder(playlist.items, query, sort), [playlist.items, query, sort])
  const tracks = useMemo(() => shown.map(index => playlist.items[index].track), [playlist.items, shown])
  const getItemKey = useCallback((index: number) => playlist.items[shown[index]].itemId, [playlist.items, shown])
  // A finger cannot drag a song onto the sidebar (on a phone it is a drawer over the songs), so touch screens are told the menu's way.
  const touch = useMediaQuery('(pointer: coarse)')
  const smart = Boolean(playlist.rules)
  const changesItems = owned && !smart
  // Songs are dragged only in the playlist's own order, all of them showing.
  const asStored = !query.trim() && sort === 'custom'
  return (
    <TrackCollection
      kind={smart ? (playlist.isPublic ? 'Public smart playlist' : 'Smart playlist') : playlist.isPublic ? 'Public playlist' : 'Playlist'}
      title={playlist.name}
      art={<PlaylistCover artworks={playlist.artworks} />}
      tint={playlist.artworks[0]?.color}
      byline={<span className="text-muted-foreground">{playlist.ownerName}</span>}
      description={playlist.description}
      tracks={tracks}
      addedAt={shown.map(index => playlist.items[index].addedAt)}
      count={playlist.items.length ? plural(playlist.items.length, 'song') : undefined}
      getItemKey={getItemKey}
      durationMs={playlist.durationMs}
      context={{ type: 'playlist', id: playlist.id, title: playlist.name }}
      onMove={changesItems && asStored ? onMove : undefined}
      onRemove={changesItems ? index => onRemove(shown[index]) : undefined}
      onRemoveMany={changesItems ? indexes => onRemoveMany(indexes.map(index => shown[index])) : undefined}
      toolbar={playlist.items.length > 1 && (
        <>
          <SearchField value={query} onValueChange={setQuery} placeholder="Find in playlist" className="w-full sm:w-64" />
          <Select label="Sort songs" prefix="Sort:" value={sort} options={playlistSortOptions} onValueChange={setSort} className="ml-auto" />
        </>
      )}
      failure={failure}
      menuEntries={owned ? [
        smart ? { label: 'Edit rules', icon: <Sparkles />, onSelect: onEdit } : { label: 'Edit details', icon: <Pencil />, onSelect: onEdit },
        playlist.isPublic
          ? { label: 'Make private', icon: <Lock />, onSelect: onTogglePublic }
          : { label: 'Make public', icon: <Globe />, onSelect: onTogglePublic },
        { kind: 'separator' },
        { label: 'Delete playlist', icon: <Trash2 />, danger: true, onSelect: onDelete },
      ] : undefined}
      empty={playlist.items.length ? (
        <EmptyState icon={<SearchX />} title="No songs match" description={`Nothing in this playlist matches “${query.trim()}”.`} action={<Button variant="outline" onClick={() => setQuery('')}>Show every song</Button>} />
      ) : smart ? (
        <EmptyState
          icon={<Sparkles />}
          title="No songs match yet"
          description="Songs show up here as soon as music that fits the rules is in your library or on this server."
          action={owned && <Button variant="primary" onClick={onEdit}>Edit rules</Button>}
        />
      ) : (
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

type MixViewProps = {
  mix: MixDetail
  /** The ⋯ menu's entries, from `mixMenuEntries` (mix-menu.tsx). */
  menu: MenuEntry[]
}

/** A mix made for the user: read-only, its songs in the order they were picked. */
export function MixView({ mix, menu }: MixViewProps) {
  return (
    <TrackCollection
      kind="Mix"
      title={mix.name}
      art={<MixCover artworks={mix.artworks} label={mixSlot(mix)} />}
      tint={mix.artworks[0]?.color}
      byline={<span className="text-muted-foreground">{mix.description}</span>}
      tracks={mix.tracks}
      durationMs={mix.durationMs}
      context={{ type: 'mix', id: mix.id, title: mix.name }}
      menuEntries={menu}
      empty={<EmptyState icon={<AudioLines />} title="Nothing in this mix plays right now" description="Its songs are back once their music is on the server again." />}
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
      onEndReached={onEndReached}
      moreFailure={moreFailure}
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
  getItemKey?: (index: number) => string
  /** Overrides "12 songs": while the list is still loading, or the whole playlist's count while a find narrows the list. */
  count?: string
  /** Null while unknown. */
  durationMs: number | null
  context: PlaybackContext
  /** Replaces playing `tracks` from a row, for lists that load the rest first. */
  onPlay?: (index: number, options?: PlayOptions) => void
  onMove?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  onRemoveMany?: (indexes: number[]) => Promise<unknown>
  /** Loads another page when the end comes into view. */
  onEndReached?: () => void
  moreFailure?: MoreFailure
  /** Controls over the songs, such as finding and sorting them. */
  toolbar?: ReactNode
  /** After Play and Shuffle in the collection's menu. */
  menuEntries?: MenuEntry[]
  empty: ReactNode
  failure?: string
}

function TrackCollection({ kind, title, art, tint, byline, description, tracks, addedAt, getItemKey, count, durationMs, context, onPlay, onMove, onRemove, onRemoveMany, onEndReached, moreFailure, toolbar, menuEntries, empty, failure }: TrackCollectionProps) {
  const controls = usePlayerControls()
  const viewer = useViewer()
  const play = onPlay ?? ((index: number, options?: PlayOptions) => controls.playTracks(tracks, index, context, options))
  const actions = useTrackActions(tracks, context, { onPlay: index => play(index), onMove, onRemove, onRemoveMany })
  // A list still loading (Liked Songs) plays once the rest is in, so its count says there is something to play.
  const playable = tracks.some(track => isPlayable(track, viewer)) || (!!count && !!onPlay)
  // Like an album's, the menu plays or shuffles the collection; there are no Play and Shuffle buttons.
  const entries: MenuEntry[] = [
    ...(tracks.length > 0 ? [
      { label: 'Play', icon: <Play />, disabled: !playable, onSelect: () => play(0, { collection: true }) },
      { label: 'Shuffle', icon: <Shuffle />, disabled: !playable, onSelect: () => play(0, { collection: true, shuffle: true }) },
    ] : []),
    ...(tracks.length > 0 && menuEntries?.length ? [{ kind: 'separator' as const }] : []),
    ...(menuEntries ?? []),
  ]
  const size = tracks.length || count ? [count ?? plural(tracks.length, 'song'), durationMs !== null && formatTotalDuration(durationMs)].filter(Boolean).join(', ') : 'No songs yet'
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
        actions={entries.length > 0 && (
          <PlayActions>
            <DropdownMenu align="start" entries={entries} trigger={<IconButton label="More options" size="lg"><MoreHorizontal /></IconButton>} />
          </PlayActions>
        )}
      />
      <div className="px-(--gutter) pb-10">
        {failure && <div className="mb-3"><FormError message={failure} /></div>}
        {toolbar && <div className="mb-3 flex flex-wrap items-center gap-2">{toolbar}</div>}
        {!tracks.length
          ? empty
          : <div className="-mx-2"><VirtualTrackList label={`${title} tracks`} tracks={tracks} addedAt={addedAt} getItemKey={getItemKey} variant="playlist" onEndReached={onEndReached} {...actions} /></div>}
        {moreFailure && <LoadError title="More songs didn’t load" {...moreFailure} className="mt-4" />}
      </div>
    </div>
  )
}
