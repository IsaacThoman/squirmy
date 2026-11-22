import type { TrackSummary } from '@squirmy/contracts'
import { ArrowDown, ArrowUp, BookmarkCheck, BookmarkPlus, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, Plus, Radio, Trash2 } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'
import { librarySaveEntry } from './library-save-entry'
import type { PlaylistChoice, TrackAction } from './TrackList'

export type TrackMenuOptions = {
  unavailable: boolean
  /** Undefined while the server has the wantlist off. */
  wanted?: boolean
  playlists?: PlaylistChoice[]
  act: (action: TrackAction) => void
  navigate: (to: string) => void
  extraMenu?: MenuEntry[]
  /** The row's place in a list the user may reorder. */
  reorder?: { index: number; count: number }
  /** The song is listed on its own album's page, so "Go to album" would lead where it already is. */
  onAlbumPage?: boolean
}

/**
 * A song's menu, the same wherever a song is listed (track lists, search results): play
 * next, queue, playlists, radio, saving it (the heart), the Wantlist, its album and artists.
 */
export function trackMenuEntries(track: TrackSummary, { unavailable, wanted, playlists, act, navigate, extraMenu, reorder, onAlbumPage = false }: TrackMenuOptions): MenuEntry[] {
  return [
    { label: 'Play next', icon: <ListStart />, onSelect: () => act('play-next'), disabled: unavailable },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => act('enqueue'), disabled: unavailable },
    ...(playlists ? [{
      kind: 'submenu' as const,
      label: 'Add to playlist',
      icon: <ListPlus />,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => act('add-to:new') },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => act(`add-to:${playlist.id}`) })),
      ],
    }] : []),
    { label: 'Start radio', icon: <Radio />, onSelect: () => act('radio'), disabled: unavailable },
    { kind: 'separator' },
    librarySaveEntry(track, () => act('like')),
    // Undefined `wanted` means the server has the wantlist off. It is for music that does not play.
    ...(!unavailable || wanted === undefined ? [] : [{ label: wanted ? 'Remove from Wantlist' : 'Add to Wantlist', icon: wanted ? <BookmarkCheck /> : <BookmarkPlus />, onSelect: () => act('want') }]),
    { kind: 'separator' },
    ...(track.album && !onAlbumPage ? [{ label: 'Go to album', icon: <Disc3 />, onSelect: () => navigate(`/album/${track.album!.id}`) }] : []),
    ...track.artists.map(artist => ({ label: track.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
    ...(extraMenu ?? []),
    ...(reorder ? [
      { kind: 'separator' as const },
      { label: 'Move up', icon: <ArrowUp />, disabled: reorder.index === 0, onSelect: () => act('move-up') },
      { label: 'Move down', icon: <ArrowDown />, disabled: reorder.index === reorder.count - 1, onSelect: () => act('move-down') },
      { label: 'Remove from playlist', icon: <Trash2 />, danger: true, onSelect: () => act('remove') },
    ] : []),
  ]
}
