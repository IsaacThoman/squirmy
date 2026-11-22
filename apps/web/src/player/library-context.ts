import type { AlbumSummary, LibraryEntityType, LikeEntityType, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext } from 'react'

export type WantTarget = { type: 'album'; album: AlbumSummary } | { type: 'track'; track: TrackSummary }

/** What Add to library and Remove from library act on. */
export type LibraryTarget = { type: LibraryEntityType; id: string; title: string }

/**
 * User data the UI changes from anywhere: likes, wants, the library and playlists. Likes,
 * wants and library changes update every cached answer at once, so views read `liked`,
 * `wanted`, `inLibrary` and `library` from their data.
 */
export type LibraryActions = {
  /** The server has the wantlist on; off, nothing offers to want music. */
  wantlistEnabled: boolean
  /** Tracks carry no `wanted` flag, so their state comes from the user's wantlist. */
  isWanted: (id: string, fromServer?: boolean) => boolean
  setLiked: (type: LikeEntityType, id: string, liked: boolean) => void
  setWanted: (target: WantTarget, wanted: boolean) => void
  /**
   * Adds to or removes from the user's library. It shows at once and never waits on the
   * music: for a requester the server fetches what is missing behind it.
   */
  setInLibrary: (target: LibraryTarget, inLibrary: boolean) => void
  /** The user's own playlists, newest change first: the ones tracks can be added to. */
  playlists: PlaylistSummary[]
  addToPlaylist: (playlist: Pick<PlaylistSummary, 'id' | 'name'>, tracks: TrackSummary[]) => void
  /** Opens the new playlist dialog; the playlist starts with `tracks` when given. */
  newPlaylist: (tracks?: TrackSummary[]) => void
}

export const LibraryContext = createContext<LibraryActions | null>(null)

export function useLibrary() {
  const library = useContext(LibraryContext)
  if (!library) throw new Error('useLibrary needs a library provider')
  return library
}
