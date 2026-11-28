import type { AlbumSummary, LikeEntityType, PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext, useSyncExternalStore } from 'react'

export type WantTarget = { type: 'album'; album: AlbumSummary } | { type: 'track'; track: TrackSummary }

/** What the heart saves to the library: a track, an album or an artist. The title names it to screen readers when a save fails. */
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
   * The heart, the one way into the library: saves or removes a track, album or artist. It
   * shows at once and never waits on the music: for a requester the server fetches what is
   * missing behind it. One the server refuses goes back, and the heart says so (`LibraryFailures`).
   * Resolves once the server has it; a caller that waits (a menu entry) can say a failure itself.
   */
  setSaved: (target: LibraryTarget, saved: boolean) => Promise<void>
  /** As `setSaved`, for the Wantlist: shows at once, goes back and says so where it was made when refused. */
  setWanted: (target: WantTarget, wanted: boolean) => Promise<void>
  /** The user's own playlists of songs, newest change first: the ones tracks can be added to. Smart playlists are not. */
  playlists: PlaylistSummary[]
  /** All of the user's own playlists, smart ones too: what a search of their playlists matches. */
  ownPlaylists: PlaylistSummary[]
  /**
   * Adds the songs, asking first about those the playlist has already. Resolves true once they
   * are added, false when the question was asked instead (the dialog it opens takes it from
   * there), and rejects when the server refused, for the place that asked to say so.
   */
  addToPlaylist: (playlist: Pick<PlaylistSummary, 'id' | 'name'>, tracks: TrackSummary[]) => Promise<boolean>
  /** Opens the new playlist dialog; the playlist starts with `tracks` when given. */
  newPlaylist: (tracks?: TrackSummary[]) => void
  /** Opens the new smart playlist dialog; the playlist opens once made. */
  newSmartPlaylist: () => void
  /** The user turned on star ratings (`showRatings`): songs' menus offer them, and smart playlists can use them. */
  showRatings: boolean
  /** Sets the user's 1 to 5 stars for a song, 0 to remove them. Shows at once, goes back if the server refuses. */
  setRating: (track: TrackSummary, rating: number) => Promise<void>
}

export const LibraryContext = createContext<LibraryActions | null>(null)

export function useLibrary() {
  const library = useContext(LibraryContext)
  if (!library) throw new Error('useLibrary needs a library provider')
  return library
}

/** How long a refused change says so beside the control that made it. */
export const FAILURE_MS = 5000

/** What failed, for the control that shows it: the heart (`save`) or the Wantlist (`want`) of one item. */
export type FailureKey = `${'save' | 'want'}:${string}`

/**
 * The library changes the server refused, for a few seconds each, so the control that made one
 * (a heart, a Wantlist button) says so beside itself rather than anywhere else. `latest` is the
 * last one with the item's name, for the one live region that tells screen readers.
 */
export class LibraryFailures {
  private readonly failures = new Map<FailureKey, string>()
  private readonly timers = new Map<FailureKey, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<() => void>()
  private announced: string | null = null

  get = (key: FailureKey): string | null => this.failures.get(key) ?? null
  latest = (): string | null => this.announced

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** `message` shows beside the control; `announcement` (with the item's name) is read out. */
  fail(key: FailureKey, message: string, announcement: string): void {
    clearTimeout(this.timers.get(key))
    this.failures.set(key, message)
    this.announced = announcement
    this.timers.set(key, setTimeout(() => this.clear(key), FAILURE_MS))
    this.emit()
  }

  clear(key: FailureKey): void {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    if (!this.failures.delete(key)) return
    if (!this.failures.size) this.announced = null
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Fixtures and components rendered alone get one that never fails. */
export const LibraryFailuresContext = createContext(new LibraryFailures())

/** The refused change of `key`, while it says so; null otherwise, or without a key. */
export function useLibraryFailure(key: FailureKey | undefined): string | null {
  const failures = useContext(LibraryFailuresContext)
  return useSyncExternalStore(failures.subscribe, () => (key ? failures.get(key) : null))
}
