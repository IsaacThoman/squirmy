import type { AlbumDetail, TrackSummary } from '@squirmy/contracts'
import { createContext, useContext } from 'react'

/** The fetch of an album asked for from this tab: its jobs, and how many are still running or failed. */
export type AlbumFetch = { jobs: number; running: number; failed: number }

/**
 * Music the server fetches on demand. Tracks being fetched show as preparing wherever they
 * appear, from the session's entries and the server's `acquisition.updated` events.
 */
export type OnDemand = {
  /** Admins, and members allowed to request music. Others see on-demand tracks as unavailable. */
  canRequest: boolean
  isPreparing: (track: Pick<TrackSummary, 'id' | 'availability' | 'album'>) => boolean
  /** Fetches the album's missing tracks. */
  getAlbum: (album: AlbumDetail) => Promise<unknown>
  /** The album's fetch, once one was asked for here. */
  albumFetch: (albumId: string) => AlbumFetch | null
}

const none: OnDemand = { canRequest: false, isPreparing: () => false, getAlbum: async () => {}, albumFetch: () => null }

export const OnDemandContext = createContext<OnDemand>(none)

export function useOnDemand(): OnDemand {
  return useContext(OnDemandContext)
}
