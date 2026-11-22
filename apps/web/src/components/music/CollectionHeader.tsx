import { BookmarkCheck, BookmarkPlus, CircleCheck, CirclePlus, Heart, Play, Shuffle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type CollectionHeaderProps = {
  /** "Album", "Playlist", "EP"… */
  kind: string
  title: string
  art: ReactNode
  /** The line under the title: artist links, owner. */
  byline?: ReactNode
  meta?: (string | null | undefined | false)[]
  /** A few lines about the collection: a playlist's description. */
  description?: string | null
  /** The artwork's dominant color; tints the header. */
  tint?: string | null
  actions?: ReactNode
}

/**
 * The top of an album, artist or playlist page, tinted with its artwork's color. These pages have
 * no header bar, so on phones it starts below the button that opens the sidebar.
 */
export function CollectionHeader({ kind, title, art, byline, meta, description, tint, actions }: CollectionHeaderProps) {
  return (
    <header className={cn('px-(--gutter) pb-6 pt-12 md:pt-10', tint && 'album-tint')} style={tint ? { '--tint': tint } as CSSProperties : undefined}>
      <div className="flex flex-col items-center gap-5 text-center md:flex-row md:items-end md:gap-7 md:text-left">
        <div className="w-[min(56vw,13rem)] shrink-0 md:w-48 lg:w-56 [&>*]:shadow-cover">{art}</div>
        <div className="flex min-w-0 flex-col items-center gap-2 md:items-start md:pb-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{kind}</span>
          {/* A very long title steps down a size, so it does not run to four lines. */}
          <h1 dir="auto" className={cn('text-balance font-semibold tracking-tight', title.length > 40 ? 'text-2xl md:text-3xl lg:text-4xl' : 'text-3xl md:text-4xl lg:text-5xl')}>{title}</h1>
          {byline && <div className="text-base font-medium">{byline}</div>}
          {meta?.some(Boolean) && <p className="text-sm text-muted-foreground">{meta.filter(Boolean).join(' · ')}</p>}
          {description && <p className="max-w-2xl text-pretty text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="mt-6 flex items-center justify-center gap-1 md:justify-start">{actions}</div>}
    </header>
  )
}

/**
 * Whether the collection is in the user's library. `collection`: music the server's owner
 * brought, in everyone's library for good; `saved`: the user added it; null: not in it.
 */
export type LibraryToggle = { state: 'collection' | 'saved' | null; onChange: (inLibrary: boolean) => void }

type PlayActionsProps = {
  title: string
  onPlay?: () => void
  onShuffle?: () => void
  /** Play was pressed and waits for the track list. */
  pending?: boolean
  library?: LibraryToggle
  liked?: boolean
  onLike?: () => void
  wanted?: boolean
  onWant?: () => void
  children?: ReactNode
}

/** Play, Shuffle, the library, Like and Want, with room for an overflow menu. */
export function PlayActions({ title, onPlay, onShuffle, pending, library, liked, onLike, wanted, onWant, children }: PlayActionsProps) {
  return (
    <>
      <IconButton label={`Play ${title}`} variant="primary" size="xl" shape="round" disabled={!onPlay} aria-busy={pending || undefined} onClick={onPlay} className="mr-2">
        {pending ? <Spinner label={null} className="text-current" /> : <Play className="translate-x-0.5" fill="currentColor" />}
      </IconButton>
      {onShuffle && <IconButton label={`Shuffle ${title}`} size="lg" onClick={onShuffle}><Shuffle /></IconButton>}
      {library && <LibraryButton library={library} />}
      {onLike && (
        <IconButton label={liked ? `Remove ${title} from your likes` : `Like ${title}`} size="lg" onClick={onLike} className={cn(liked && 'text-primary hover:text-primary')}>
          <Heart fill={liked ? 'currentColor' : 'none'} />
        </IconButton>
      )}
      {onWant && (
        <IconButton label={wanted ? 'Remove from Wantlist' : 'Add to Wantlist'} size="lg" onClick={onWant} className={cn(wanted && 'text-primary hover:text-primary')}>
          {wanted ? <BookmarkCheck /> : <BookmarkPlus />}
        </IconButton>
      )}
      {children}
    </>
  )
}

/**
 * Add to library, a plus that turns into a check at once. On a collection album the check
 * stays put: removing the server's own music is an admin's job, not a library choice.
 */
function LibraryButton({ library }: { library: LibraryToggle }) {
  if (library.state === 'collection') {
    return (
      <Tooltip label="On this server">
        <span role="img" aria-label="On this server" tabIndex={0} className="inline-flex size-10 items-center justify-center rounded-md text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5">
          <CircleCheck />
        </span>
      </Tooltip>
    )
  }
  const saved = library.state === 'saved'
  return (
    <IconButton
      label={saved ? 'Remove from library' : 'Add to library'}
      size="lg"
      onClick={() => library.onChange(!saved)}
      className={cn(saved && 'text-primary hover:text-primary')}
    >
      {saved ? <CircleCheck /> : <CirclePlus />}
    </IconButton>
  )
}
