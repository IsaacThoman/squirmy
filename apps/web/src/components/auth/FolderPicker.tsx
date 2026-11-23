import type { DirectoryListing } from '@squirmy/contracts'
import { ArrowUp, ChevronRight, Folder } from 'lucide-react'
import { useState } from 'react'
import { Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { ScrollArea } from '@/components/ui/scroll-area'

type FolderPickerProps = {
  /** The folder asked for, shown in the path field even when it cannot be listed. */
  path: string | undefined
  /** Its contents. Undefined while loading or after an error. */
  listing: DirectoryListing | undefined
  error?: string
  onBrowse: (path: string) => void
}

/** Browses the server's directories. The folder on screen is the selection. */
export function FolderPicker({ path, listing, error, onBrowse }: FolderPickerProps) {
  const [typed, setTyped] = useState<string | null>(null)
  const go = () => {
    if (typed?.trim()) onBrowse(typed.trim())
    setTyped(null)
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-1 border-b bg-muted/40 p-1">
        <IconButton label="Parent folder" size="sm" disabled={!listing?.parent} onClick={() => listing?.parent && onBrowse(listing.parent)}><ArrowUp /></IconButton>
        <input
          aria-label="Folder path"
          value={typed ?? path ?? ''}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            go()
          }}
          onBlur={go}
          spellCheck={false}
          autoCapitalize="none"
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-base text-foreground outline-none focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring md:text-xs"
        />
      </div>
      <ScrollArea className="h-48">
        {error && <p role="alert" className="px-3 py-2.5 text-sm text-destructive">{error}</p>}
        {!error && !listing && (
          <div className="flex flex-col gap-3 px-3.5 py-3">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-4" style={{ width: `${[45, 60, 35, 50][index]}%` }} />)}</div>
        )}
        {!error && listing?.directories.length === 0 && <p className="px-3 py-2.5 text-sm text-muted-foreground">No folders inside this one.</p>}
        {!error && listing && listing.directories.length > 0 && (
          <ul className="p-1">
            {listing.directories.map(directory => (
              <li key={directory.path}>
                <button
                  type="button"
                  onClick={() => onBrowse(directory.path)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11"
                >
                  <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
