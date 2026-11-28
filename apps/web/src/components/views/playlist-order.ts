import type { PlaylistItem } from '@squirmy/contracts'
import type { SelectOption } from '@/components/ui/select'
import { matches } from './library-state'

/** How a playlist's songs are listed. `custom` is the playlist's own order, the only one songs are dragged in. */
export type PlaylistSort = 'custom' | 'title' | 'artist' | 'album' | 'added' | 'duration'

export const playlistSortOptions: SelectOption<PlaylistSort>[] = [
  { value: 'custom', label: 'Custom order' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'added', label: 'Recently added' },
  { value: 'duration', label: 'Length' },
]

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
/** Titles and names sort without a leading article, as the library's lists do. */
const sortable = (value: string) => value.replace(/^(the|a|an)\s+/i, '')

const compare: Record<Exclude<PlaylistSort, 'custom'>, (a: PlaylistItem, b: PlaylistItem) => number> = {
  title: (a, b) => collator.compare(sortable(a.track.title), sortable(b.track.title)),
  artist: (a, b) => collator.compare(sortable(a.track.artistCredit), sortable(b.track.artistCredit))
    || collator.compare(a.track.album?.title ?? '', b.track.album?.title ?? '')
    || (a.track.disc ?? 0) - (b.track.disc ?? 0) || (a.track.position ?? 0) - (b.track.position ?? 0),
  album: (a, b) => collator.compare(sortable(a.track.album?.title ?? ''), sortable(b.track.album?.title ?? ''))
    || (a.track.disc ?? 0) - (b.track.disc ?? 0) || (a.track.position ?? 0) - (b.track.position ?? 0),
  added: (a, b) => b.addedAt.localeCompare(a.addedAt),
  duration: (a, b) => a.track.durationMs - b.track.durationMs,
}

/**
 * The places, in `items`, of the songs to list: those matching `query` (every word somewhere in
 * the title, the artists or the album), in `sort`'s order. Ties keep the playlist's order.
 */
export function playlistOrder(items: readonly PlaylistItem[], query: string, sort: PlaylistSort): number[] {
  const kept = items.flatMap((item, index) => (!query.trim() || matches(query, item.track.title, item.track.artistCredit, item.track.album?.title ?? '') ? [index] : []))
  if (sort === 'custom') return kept
  return kept.sort((a, b) => compare[sort](items[a]!, items[b]!) || a - b)
}
