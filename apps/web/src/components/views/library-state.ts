import type { LibrarySort } from '@squirmy/contracts'

/**
 * The Library's filter chips, as the iOS app has them. `all`: Liked Songs, the playlists, then
 * the albums. The filter is in the URL (`/library?filter=albums`), which deep links use.
 */
export const LIBRARY_FILTERS = ['all', 'playlists', 'albums', 'artists', 'songs'] as const
export type LibraryFilterName = (typeof LIBRARY_FILTERS)[number]

export const filterLabels: Record<LibraryFilterName, string> = { all: 'All', playlists: 'Playlists', albums: 'Albums', artists: 'Artists', songs: 'Songs' }

export const isLibraryFilter = (value: string | null): value is LibraryFilterName => LIBRARY_FILTERS.includes(value as LibraryFilterName)

export type LibraryLayout = 'grid' | 'list'

const allSorts: LibrarySort[] = ['recent', 'title', 'artist', 'year']

/**
 * The orders a filter can be shown in, as on iOS. Songs have no year (the server refuses that
 * order), artists are always listed by name, and playlists come in the server's order.
 */
export function sortsFor(filter: LibraryFilterName): LibrarySort[] {
  switch (filter) {
    case 'songs': return allSorts.filter(sort => sort !== 'year')
    case 'artists':
    case 'playlists': return []
    default: return allSorts
  }
}

/** The chosen order where the filter offers it, else the default; the choice is kept for when it applies again. */
export function sortFor(filter: LibraryFilterName, chosen: LibrarySort): LibrarySort {
  return sortsFor(filter).includes(chosen) ? chosen : 'recent'
}

export const isLibrarySort = (value: string | null): value is LibrarySort => allSorts.includes(value as LibrarySort)

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
