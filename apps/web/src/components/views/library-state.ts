import { LIKED_SONGS_ID, type LibraryItemsSort, type LibraryPinKind } from '@squirmy/contracts'
import type { LibraryItem } from './LibraryView'

/**
 * The Library's filter chips. `all`: Liked Songs, the playlists, the albums and the artists
 * together, recently played first (`GET /library/items`), which is the iOS app's whole Library: it has no chips. The filter is in the URL (`/library?filter=albums`), which deep links use.
 */
export const LIBRARY_FILTERS = ['all', 'playlists', 'albums', 'artists', 'songs'] as const
export type LibraryFilterName = (typeof LIBRARY_FILTERS)[number]

export const filterLabels: Record<LibraryFilterName, string> = { all: 'All', playlists: 'Playlists', albums: 'Albums', artists: 'Artists', songs: 'Songs' }

export const isLibraryFilter = (value: string | null): value is LibraryFilterName => LIBRARY_FILTERS.includes(value as LibraryFilterName)

export type LibraryLayout = 'grid' | 'list'

const listSorts: LibraryItemsSort[] = ['recent', 'title', 'artist', 'year']
const allSorts: LibraryItemsSort[] = ['played', ...listSorts]

/**
 * The orders a filter can be shown in, as on iOS. All alone has recently played (what was
 * played is a collection: an album, artist or playlist). Songs have no year (the server
 * refuses that order), artists are always listed by name, and playlists come in the server's order.
 */
export function sortsFor(filter: LibraryFilterName): LibraryItemsSort[] {
  switch (filter) {
    case 'all': return allSorts
    case 'songs': return listSorts.filter(sort => sort !== 'year')
    case 'artists':
    case 'playlists': return []
    default: return listSorts
  }
}

/** The order a filter opens in: recently played for All, recently added for the rest. */
export const defaultSort = (filter: LibraryFilterName): LibraryItemsSort => (filter === 'all' ? 'played' : 'recent')

/**
 * The chosen order where the filter offers it, else the filter's default; the choice is kept
 * for when it applies again. Nothing is chosen until the URL says so: the sort is not stored.
 */
export function sortFor(filter: LibraryFilterName, chosen: LibraryItemsSort | null): LibraryItemsSort {
  return chosen && sortsFor(filter).includes(chosen) ? chosen : defaultSort(filter)
}

export const isLibrarySort = (value: string | null): value is LibraryItemsSort => allSorts.includes(value as LibraryItemsSort)

/** Whether every word typed is somewhere in `values`, ignoring case and accents: the filter of what is loaded. */
export function matches(query: string, ...values: string[]) {
  const normalized = (value: string) => value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const text = normalized(values.join(' '))
  return normalized(query).split(/\s+/).every(token => text.includes(token))
}

const FILTER_KEY = 'squirmy.library.filter'
const LAYOUT_KEY = 'squirmy.library.layout'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The preference is optional.
  }
}

/** The filter this browser last chose, which `/library` opens on. */
export function readLibraryFilter(): LibraryFilterName {
  const saved = read(FILTER_KEY)
  return isLibraryFilter(saved) ? saved : 'all'
}

export function writeLibraryFilter(filter: LibraryFilterName) {
  write(FILTER_KEY, filter)
}

/** Grid or list, per browser. Songs are always a list. */
export function readLibraryLayout(): LibraryLayout {
  return read(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
}

export function writeLibraryLayout(layout: LibraryLayout) {
  write(LAYOUT_KEY, layout)
}

/** The kind and id that pin an item of All to the top (`PUT /me/pins/:kind/:id`). */
export function pinTarget(item: LibraryItem): [LibraryPinKind, string] {
  switch (item.kind) {
    case 'liked': return ['liked', LIKED_SONGS_ID]
    case 'playlist': return ['playlist', item.playlist.id]
    case 'album': return ['album', item.album.id]
    case 'artist': return ['artist', item.artist.id]
  }
}
