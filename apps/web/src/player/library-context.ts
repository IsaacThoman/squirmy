import type { AlbumSummary, LikeEntityType, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext } from 'react'

export type WantTarget = { type: 'album'; album: AlbumSummary } | { type: 'track'; track: TrackSummary }

/** What the heart saves to the library: a track, an album or an artist. The title is for the toast. */
export type LibraryTarget = { type: LikeEntityType; id: string; title: string }

/**
 * User data the UI changes from anywhere: the library, wants and playlists. Saves and wants
 * update every cached answer at once, so views read `liked` and `wanted` from their data.
 */
export type LibraryActions = {
  /** The server has the wantlist on; off, nothing offers to want music. */
  wantlistEnabled: boolean
  /** Tracks carry no `wanted` flag, so their state comes from the user's wantlist. */
  isWanted: (id: string, fromServer?: boolean) => boolean
  /**
   * The heart, the one way into the library: saves or removes a track, album or artist and
   * says so in a toast with Undo (`quiet` leaves the toast to the caller). It shows at once and
   * never waits on the music: for a requester the server fetches what is missing behind it.
   */
  setSaved: (target: LibraryTarget, saved: boolean, options?: { quiet?: boolean }) => void
  setWanted: (target: WantTarget, wanted: boolean) => void
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
