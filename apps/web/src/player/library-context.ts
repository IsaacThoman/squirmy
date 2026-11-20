import type { LikeEntityType } from '@squirmy/contracts'
import { createContext, useContext } from 'react'

/** User data the UI changes from anywhere: likes and wants. */
export type LibraryActions = {
  /** Applies local changes on top of what a response said. */
  isLiked: (id: string, fromServer: boolean) => boolean
  isWanted: (id: string, fromServer: boolean) => boolean
  setLiked: (type: LikeEntityType, id: string, liked: boolean) => void
  setWanted: (type: 'album' | 'track', id: string, wanted: boolean) => void
}

export const LibraryContext = createContext<LibraryActions | null>(null)

export function useLibrary() {
  const library = useContext(LibraryContext)
  if (!library) throw new Error('useLibrary needs a library provider')
  return library
}
