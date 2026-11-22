import type { SearchItem } from '@squirmy/client-core'
import { albumTypeLabel } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/** How a result reads in a list: its artwork (round for artists), its name, and "Kind · Artist" under it. */
export function searchItemText(item: SearchItem): { title: string; detail: string } {
  switch (item.type) {
    case 'artist': return { title: item.artist.name, detail: 'Artist' }
    case 'album': return { title: item.album.title, detail: `${albumTypeLabel(item.album.type)} · ${item.album.artistCredit}` }
    case 'track': return { title: item.track.title, detail: `Song · ${item.track.artistCredit}` }
    case 'playlist': return { title: item.playlist.name, detail: `Playlist · ${item.playlist.ownerName}` }
  }
}

/** A result row's surface: highlighted when the keyboard or pointer rests on it, faded while it answers an earlier query. */
export const searchRowClass = (active: boolean, stale: boolean) => cn(
  'flex w-full items-center gap-3 rounded-md px-2.5 text-left text-sm outline-none transition-[opacity,background-color]',
  active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
  stale && 'opacity-60',
)
