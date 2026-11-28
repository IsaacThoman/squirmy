import type { ArtistRef, PlaylistSummary } from '@squirmy/contracts'
import { ListEnd, ListMusic, ListPlus, ListStart, MicVocal, Play, Plus, Share2, Shuffle } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'
import { librarySaveEntry, wantEntry } from './library-save-entry'

export type AlbumMenuOptions = {
  artists: ArtistRef[]
  /** Something on it plays: Play, Play next and Add to queue need it. */
  playable: boolean
  /** Offered where nothing else plays the album, such as on a card. */
  onPlay?: () => void
  /** Beside Play, as in the iOS app's menus. */
  onShuffle?: () => void
  /** Waits for the album's songs when it has to fetch them; a failure is said on the entry. */
  onEnqueue: (placement: 'next' | 'last') => void | Promise<unknown>
  /** The user's own playlists; `null` is a new one. */
  playlists: PlaylistSummary[]
  /** As `LibraryActions.addToPlaylist`: resolves true once added, false when it asked about songs already there. */
  onAddToPlaylist: (playlist: PlaylistSummary | null) => void | Promise<unknown>
  /**
   * False while the album's songs are not known yet (the server is still looking them up): there
   * is nothing to add, and a new playlist would start empty.
   */
  songsKnown?: boolean
  /** Whether it is saved, undefined until the album is loaded: the entry waits for it. */
  liked: boolean | undefined
  onToggleSaved: () => void | Promise<unknown>
  /** For music that does not play, while the server has the Wantlist on. */
  want?: { wanted: boolean; onToggle: () => void | Promise<unknown> }
  onGoToArtist: (artist: ArtistRef) => void
  /** Makes a public link to the album, while the server allows sharing. */
  onShare?: () => void
}

/**
 * An album's menu, the same on its page and on its cards, wherever they are: play or shuffle it, queue it,
 * add it to a playlist, the one library entry, the Wantlist for what does not play, and its artists.
 */
export function albumMenuEntries(options: AlbumMenuOptions): MenuEntry[] {
  const { artists, playable, onPlay, onShuffle, onEnqueue, playlists, onAddToPlaylist, songsKnown = true, liked, onToggleSaved, want, onGoToArtist, onShare } = options
  return [
    ...(onPlay ? [{ label: 'Play', icon: <Play />, disabled: !playable, onSelect: onPlay }] : []),
    ...(onShuffle ? [{ label: 'Shuffle', icon: <Shuffle />, disabled: !playable, onSelect: onShuffle }] : []),
    // The queue may be out of sight: the entry says it worked.
    { label: 'Play next', icon: <ListStart />, disabled: !playable, onSelect: () => onEnqueue('next'), done: 'Playing next' },
    { label: 'Add to queue', icon: <ListEnd />, disabled: !playable, onSelect: () => onEnqueue('last'), done: 'Added to queue' },
    {
      kind: 'submenu',
      label: 'Add to playlist',
      icon: <ListPlus />,
      disabled: !songsKnown,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => onAddToPlaylist(null) },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => onAddToPlaylist(playlist), done: `Added to ${playlist.name}` })),
      ],
    },
    { ...librarySaveEntry({ liked: liked ?? false }, onToggleSaved), disabled: liked === undefined },
    ...(want ? [wantEntry(want.wanted, want.onToggle)] : []),
    ...(onShare ? [{ label: 'Share…', icon: <Share2 />, onSelect: onShare }] : []),
    { kind: 'separator' },
    ...artists.map(artist => ({ label: `Go to ${artist.name}`, icon: <MicVocal />, onSelect: () => onGoToArtist(artist) })),
  ]
}

export type PlaylistMenuOptions = {
  /** It has no songs: nothing to play, queue or add. */
  empty: boolean
  onPlay: () => void
  /** Waits for the playlist's songs; resolves false when none of them plays, so the entry says nothing. */
  onEnqueue: (placement: 'next' | 'last') => void | Promise<unknown>
  /** The user's other playlists; `null` is a new one. */
  playlists: PlaylistSummary[]
  onAddToPlaylist: (playlist: PlaylistSummary | null) => void | Promise<unknown>
  onOpen: () => void
  /** Makes a public link to the playlist, while the server allows sharing. */
  onShare?: () => void
}

/** A playlist's menu on its card: as an album's, without the library (a playlist is the user's already) and the artists. */
export function playlistMenuEntries({ empty, onPlay, onEnqueue, playlists, onAddToPlaylist, onOpen, onShare }: PlaylistMenuOptions): MenuEntry[] {
  return [
    { label: 'Play', icon: <Play />, disabled: empty, onSelect: onPlay },
    { label: 'Play next', icon: <ListStart />, disabled: empty, onSelect: () => onEnqueue('next'), done: 'Playing next' },
    { label: 'Add to queue', icon: <ListEnd />, disabled: empty, onSelect: () => onEnqueue('last'), done: 'Added to queue' },
    {
      kind: 'submenu',
      label: 'Add to playlist',
      icon: <ListPlus />,
      disabled: empty,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => onAddToPlaylist(null) },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => onAddToPlaylist(playlist), done: `Added to ${playlist.name}` })),
      ],
    },
    ...(onShare ? [{ label: 'Share…', icon: <Share2 />, onSelect: onShare }] : []),
    { kind: 'separator' },
    { label: 'Go to playlist', icon: <ListMusic />, onSelect: onOpen },
  ]
}
