import type { TrackSummary } from '@squirmy/contracts'
import { ArrowDown, ArrowUp, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, Plus, Radio, Trash2 } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'
import { librarySaveEntry, wantEntry } from './library-save-entry'
import type { PlaylistChoice, TrackAction } from './TrackList'

export type TrackMenuOptions = {
  unavailable: boolean
  /** Undefined while the server has the wantlist off. */
  wanted?: boolean
  playlists?: PlaylistChoice[]
  /** Resolves (or rejects) for the actions that answer later, which their entries wait for. */
  act: (action: TrackAction) => void | Promise<unknown>
  navigate: (to: string) => void
  extraMenu?: MenuEntry[]
  /** The row's place in a list the user may reorder. */
  reorder?: { index: number; count: number }
  /** The song is listed on its own album's page, so "Go to album" would lead where it already is. */
  onAlbumPage?: boolean
}

/**
 * A song's menu, the same wherever a song is listed (track lists, search results): on a touch
 * screen its whole title and credit, then play next, queue, playlists, radio, saving it (the heart), the Wantlist, its album and artists.
 */
export function trackMenuEntries(track: TrackSummary, { unavailable, wanted, playlists, act, navigate, extraMenu, reorder, onAlbumPage = false }: TrackMenuOptions): MenuEntry[] {
  return [
    // On a touch screen the menu opens with the song's whole title and credit, which its row cuts short.
    { kind: 'header', label: track.title, detail: track.artistCredit },
    // The queue may be out of sight: the entry says it worked.
    { label: 'Play next', icon: <ListStart />, onSelect: () => act('play-next'), done: 'Playing next', disabled: unavailable },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => act('enqueue'), done: 'Added to queue', disabled: unavailable },
    ...(playlists ? [{
      kind: 'submenu' as const,
      label: 'Add to playlist',
      icon: <ListPlus />,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => act('add-to:new') },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => act(`add-to:${playlist.id}`), done: `Added to ${playlist.name}` })),
      ],
    }] : []),
    { label: 'Start radio', icon: <Radio />, onSelect: () => act('radio'), disabled: unavailable },
    { kind: 'separator' },
    librarySaveEntry(track, () => act('like')),
    // Undefined `wanted` means the server has the wantlist off. It is for music that does not play.
    ...(!unavailable || wanted === undefined ? [] : [wantEntry(wanted, () => act('want'))]),
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
