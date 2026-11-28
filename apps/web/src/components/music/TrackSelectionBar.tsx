import type { TrackSummary } from '@squirmy/contracts'
import { Disc3, Heart, ListEnd, ListMusic, ListStart, Play, Plus, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { MenuEntry } from '@/components/ui/menu'
import { isPlayable } from '@/lib/catalog'
import { useViewer } from '@/player/on-demand-context'
import { useSelectionSize, type Selection } from './selection'
import { SelectionBar, type BarAction } from './SelectionBar'
import { selectionMenuEntries, songsLabel } from './track-menu'
import type { TrackBatch } from './track-selection'

export type BarProps = { selection: Selection; tracks: TrackSummary[]; batch?: TrackBatch; onAlbumPage: boolean }

/** The bar while any row is picked, and what screen readers hear of the count. */
export function TrackSelectionBar({ selection, tracks, batch, onAlbumPage }: BarProps) {
  const size = useSelectionSize(selection)
  const viewer = useViewer()
  const navigate = useNavigate()
  const announced = size ? `${songsLabel(size)} selected` : ''
  const live = <span aria-live="polite" className="sr-only">{announced}</span>
  if (!size || !batch) return live
  const indexes = selection.indexes()
  const songs = indexes.map(index => tracks[index]).filter(Boolean)
  const unavailable = !songs.some(track => isPlayable(track, viewer))
  const allSaved = songs.every(track => track.liked)
  const act = (action: Parameters<TrackBatch['act']>[0]) => batch.act(action, indexes)
  const single = songs.length === 1 ? songs[0] : null
  const play: BarAction = { key: 'play', label: 'Play', icon: <Play fill="currentColor" />, disabled: unavailable, onSelect: () => act('play') }
  const actions: BarAction[] = [
    { key: 'play-next', label: 'Play next', icon: <ListStart />, done: 'Playing next', disabled: unavailable, onSelect: () => act('play-next') },
    { key: 'enqueue', label: 'Add to queue', icon: <ListEnd />, done: 'Added to queue', disabled: unavailable, onSelect: () => act('enqueue') },
    {
      key: 'save',
      label: allSaved ? 'Remove from library' : 'Save to library',
      done: allSaved ? 'Removed from library' : 'Saved to library',
      icon: <Heart fill={allSaved ? 'currentColor' : 'none'} className={allSaved ? 'text-primary' : undefined} />,
      onSelect: () => act(allSaved ? 'unsave' : 'save'),
    },
    ...(single?.album && !onAlbumPage ? [{ key: 'album', label: 'Go to album', icon: <Disc3 />, onSelect: () => void navigate(`/album/${single.album!.id}`) }] : []),
    ...(batch.remove ? [{ key: 'remove', label: `Remove from ${batch.remove}`, icon: <Trash2 />, danger: true, onSelect: () => act('remove') }] : []),
  ]
  const playlists: MenuEntry[] | undefined = batch.playlists && [
    { label: 'New playlist…', icon: <Plus />, onSelect: () => act('add-to:new') },
    ...(batch.playlists.length ? [{ kind: 'separator' as const }] : []),
    ...batch.playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => act(`add-to:${playlist.id}`), done: `Added to ${playlist.name}` })),
  ]
  const menu = selectionMenuEntries(songs, { unavailable, playlists: batch.playlists, remove: batch.remove, act })
  return (
    <>
      {live}
      <SelectionBar summary={`${songsLabel(size)} selected`} primary={play} actions={actions} playlists={playlists} menu={menu} onClear={() => selection.clear()} />
    </>
  )
}
