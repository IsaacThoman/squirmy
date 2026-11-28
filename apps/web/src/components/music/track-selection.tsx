import type { TrackSummary } from '@squirmy/contracts'
import { createContext, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { MenuEntry } from '@/components/ui/menu'
import { isPlayable } from '@/lib/catalog'
import { useViewer } from '@/player/on-demand-context'
import { SelectionContext, type Selection } from './selection'
import { selectionMenuEntries } from './track-menu'
import { TrackSelectionBar } from './TrackSelectionBar'
import type { PlaylistChoice } from './TrackList'
import { useListSelection } from './use-list-selection'

/**
 * What can be done to several songs at once. `save` and `unsave` are the heart's two ways; the
 * rest are as a song's menu has them.
 */
export type BatchAction = 'play' | 'play-next' | 'enqueue' | 'save' | 'unsave' | 'remove' | `add-to:${string}`

/** A list's actions on its picked rows, by their indexes in the list's order. */
export type TrackBatch = {
  act: (action: BatchAction, indexes: number[]) => void | Promise<unknown>
  /** What Remove takes them out of ("playlist"); left out where songs cannot be removed. */
  remove?: string
  playlists?: PlaylistChoice[]
}

/**
 * What a row needs from its list's selection beyond its own mark: the songs to drag and the
 * menu to open when it is one of several picked. Kept to one identity so memoized rows are not
 * rendered again.
 */
export type PickedTracks = {
  selection: Selection
  /** The picked songs in the list's order, when there are several; else null, and the row acts alone. */
  several: () => TrackSummary[] | null
  /** The menu of the picked songs. */
  menu: () => MenuEntry[]
}

export const PickedTracksContext = createContext<PickedTracks | null>(null)

export function usePickedTracks() {
  return useContext(PickedTracksContext)
}

type Options = {
  tracks: TrackSummary[]
  keys: readonly string[]
  batch?: TrackBatch
  list: RefObject<HTMLElement | null>
  /** On an album page, Go to album would lead where the songs are. */
  onAlbumPage?: boolean
}

/**
 * Multi-select for a list of songs: the selection (`useListSelection`), the providers its rows
 * read, and the bar of what can be done to the picked songs. The list itself does not render
 * again as rows are picked; only the rows that change and the bar do.
 */
export function useTrackSelection({ tracks, keys, batch, list, onAlbumPage = false }: Options) {
  const { rows, onListKeyDown } = useListSelection(keys, list)
  const viewer = useViewer()
  const latest = useRef({ tracks, batch, viewer })
  useLayoutEffect(() => { latest.current = { tracks, batch, viewer } })
  const [picked] = useState<PickedTracks>(() => ({
    selection: rows.selection,
    several: () => {
      const indexes = rows.selection.indexes()
      return indexes.length > 1 ? indexes.map(index => latest.current.tracks[index]) : null
    },
    menu: () => {
      const { tracks, batch, viewer } = latest.current
      const indexes = rows.selection.indexes()
      const songs = indexes.map(index => tracks[index])
      if (!batch) return []
      return selectionMenuEntries(songs, {
        unavailable: !songs.some(track => isPlayable(track, viewer)),
        playlists: batch.playlists,
        remove: batch.remove,
        act: action => batch.act(action, indexes),
      })
    },
  }))

  const provide = (children: ReactNode) => (
    <SelectionContext value={rows}>
      <PickedTracksContext value={picked}>{children}</PickedTracksContext>
    </SelectionContext>
  )
  const bar = <TrackSelectionBar selection={rows.selection} tracks={tracks} batch={batch} onAlbumPage={onAlbumPage} />
  return { provide, bar, onListKeyDown: onListKeyDown as (event: KeyboardEvent) => void }
}
