import type { AlbumSummary } from '@squirmy/contracts'
import { ChevronRight } from 'lucide-react'
import { Cover } from '@/components/music/Cover'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/feedback'
import { SearchField } from '@/components/ui/search-field'

type FindAlbumDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  /** Undefined while searching or before anything is typed. */
  albums: AlbumSummary[] | undefined
  onPick: (album: AlbumSummary) => void
}

/** Finds an album in the library to fix its match. */
export function FindAlbumDialog({ open, onOpenChange, query, onQueryChange, albums, onPick }: FindAlbumDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Fix a match" description="Find the album in your library, then choose what it should be.">
        <SearchField value={query} onValueChange={onQueryChange} placeholder="Album or artist" autoFocus />
        <div className="-mx-2 min-h-48">
          {query.trim() && !albums && <div className="flex flex-col gap-2 px-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-14" />)}</div>}
          {albums?.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">No album in the library matches “{query.trim()}”.</p>}
          {albums && albums.length > 0 && (
            <ul aria-label="Albums">
              {albums.map(album => (
                <li key={album.id}>
                  <button type="button" onClick={() => onPick(album)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-overlay">
                    <Cover artwork={album.artwork} size={96} className="size-11 rounded-md" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold" title={album.title}>{album.title}</span>
                      <span className="block truncate text-xs text-muted">{album.artistCredit}{album.year ? ` · ${album.year}` : ''}{album.mbid ? '' : ' · from tags'}</span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-quiet" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
