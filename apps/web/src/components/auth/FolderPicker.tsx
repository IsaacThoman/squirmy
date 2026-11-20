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
    <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-transparent focus-within:ring-stroke">
      <div className="flex items-center gap-1 border-b border-stroke p-1.5">
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
          className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-2 font-mono text-[13px] text-foreground outline-none focus-visible:bg-overlay"
        />
      </div>
      <ScrollArea className="h-48">
        {error && <p role="alert" className="px-4 py-3 text-sm font-medium text-danger">{error}</p>}
        {!error && !listing && (
          <div className="flex flex-col gap-2 p-3">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-6" />)}</div>
        )}
        {!error && listing?.directories.length === 0 && <p className="px-4 py-3 text-sm text-quiet">No folders inside this one.</p>}
        {!error && listing && listing.directories.length > 0 && (
          <ul className="p-1">
            {listing.directories.map(directory => (
              <li key={directory.path}>
                <button
                  type="button"
                  onClick={() => onBrowse(directory.path)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium transition-colors hover:bg-overlay focus-visible:bg-overlay focus-visible:outline-none"
                >
                  <Folder aria-hidden className="size-4 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-quiet" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
