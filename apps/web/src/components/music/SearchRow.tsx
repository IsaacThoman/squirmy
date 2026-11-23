import type { SearchItem } from '@squirmy/client-core'
import type { ReactNode } from 'react'
import { ExplicitBadge } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'
import { Monogram } from './Cards'
import { PlaylistCover } from './CollectionArt'
import { Cover } from './Cover'

/** The artwork of a result, at the size `className` gives it. */
export function SearchItemArt({ item, dimmed, className }: { item: SearchItem; dimmed?: boolean; className: string }) {
  switch (item.type) {
    case 'artist':
      return item.artist.image
        ? <Cover artwork={item.artist.image} round dimmed={dimmed} size={96} className={className} />
        : <Monogram name={item.artist.name} className={cn(className, 'shrink-0 text-sm', dimmed && 'opacity-55')} />
    case 'album': return <Cover artwork={item.album.artwork} dimmed={dimmed} size={96} className={cn(className, 'rounded-[5px]')} />
    case 'track': return <Cover artwork={item.track.album?.artwork ?? null} dimmed={dimmed} size={96} className={cn(className, 'rounded-[5px]')} />
    case 'playlist': return <PlaylistCover artworks={item.playlist.artworks} className={cn(className, 'rounded-[5px]')} />
  }
}

type SearchRowBodyProps = {
  art: ReactNode
  title: string
  detail?: string
  /** Bold title: results, not places to go. */
  strong?: boolean
  dimmed?: boolean
  /** The song is the current one: its title takes the accent color. */
  current?: boolean
  explicit?: boolean
  /** Said to screen readers after the title, such as "Not available". */
  note?: string
  /** The detail line's id, for the row's control to be described by it. */
  detailId?: string
}

/**
 * The inside of a result row: artwork, then the title over "Kind · Artist". The search
 * dialog and the search page both draw their rows with it, so the two read the same.
 */
export function SearchRowBody({ art, title, detail, strong = true, dimmed, current, explicit, note, detailId }: SearchRowBodyProps) {
  return (
    <>
      {art}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span dir="auto" title={title} className={cn('truncate', strong && 'font-medium', dimmed && 'text-muted-foreground', current && 'text-primary')}>{title}</span>
          {explicit && <ExplicitBadge />}
          {note && <span className="sr-only">({note})</span>}
        </span>
        {detail && <span id={detailId} dir="auto" className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
    </>
  )
}
