import { BookmarkCheck, BookmarkPlus, Play, Shuffle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { headerTints } from '@/lib/color-themes'
import { cn } from '@/lib/utils'
import { SaveHeart } from './LibrarySave'

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
  const tints = tint ? headerTints(tint) : null
  // Secondary words are a little nearer the text than muted text: over a strong tint, muted text drops under 4.5:1.
  const secondary = tints ? 'text-tint-muted-foreground' : 'text-muted-foreground'
  return (
    <header className={cn('px-(--gutter) pb-6 pt-[calc(3rem+var(--breadcrumb-space,0px))] md:pt-[calc(2.5rem+var(--breadcrumb-space,0px))]', tints && 'album-tint')} style={tints ? { '--tint': tints.light, '--tint-dark': tints.dark } as CSSProperties : undefined}>
      <div className="flex flex-col items-center gap-5 text-center md:flex-row md:items-end md:gap-7 md:text-left">
        <div className="w-[min(56vw,13rem)] shrink-0 md:w-48 lg:w-56 [&>*]:shadow-cover">{art}</div>
        {/* A name with no spaces (a long unbroken title) breaks anywhere rather than run past the edge. */}
        <div className="flex min-w-0 max-w-full flex-col items-center gap-2 wrap-anywhere md:items-start md:pb-1">
          <span className={cn('text-[11px] font-medium uppercase tracking-wider', secondary)}>{kind}</span>
          {/* A very long title steps down a size, so it does not run to four lines. */}
          <h1 dir="auto" className={cn('text-balance font-semibold tracking-tight', title.length > 40 ? 'text-2xl md:text-3xl lg:text-4xl' : 'text-3xl md:text-4xl lg:text-5xl')}>{title}</h1>
          {byline && <div className="text-base font-medium">{byline}</div>}
          {meta?.some(Boolean) && <p className={cn('text-sm', secondary)}>{meta.filter(Boolean).join(' · ')}</p>}
          {description && <p className={cn('max-w-2xl text-pretty text-sm', secondary)}>{description}</p>}
        </div>
      </div>
      {actions && <div className="mt-6 flex items-center justify-center gap-1 md:justify-start">{actions}</div>}
    </header>
  )
}

type PlayActionsProps = {
  title: string
  onPlay?: () => void
  onShuffle?: () => void
  /** Play was pressed and waits for the track list. */
  pending?: boolean
  /** The heart: saved to the user's library. */
  liked?: boolean
  onLike?: () => void
  wanted?: boolean
  onWant?: () => void
  children?: ReactNode
}

/** Play, Shuffle, the heart and Want, with room for an overflow menu. */
export function PlayActions({ title, onPlay, onShuffle, pending, liked = false, onLike, wanted, onWant, children }: PlayActionsProps) {
  return (
    <>
      <IconButton label={`Play ${title}`} variant="primary" size="xl" shape="round" disabled={!onPlay} aria-busy={pending || undefined} onClick={onPlay} className="mr-2">
        {pending ? <Spinner label={null} className="text-current" /> : <Play className="translate-x-0.5" fill="currentColor" />}
      </IconButton>
      {onShuffle && <IconButton label={`Shuffle ${title}`} size="lg" onClick={onShuffle}><Shuffle /></IconButton>}
      {onLike && <SaveHeart liked={liked} onToggle={onLike} size="lg" />}
      {onWant && (
        <IconButton label={wanted ? 'Remove from Wantlist' : 'Add to Wantlist'} size="lg" onClick={onWant} className={cn(wanted && 'text-primary hover:text-primary')}>
          {wanted ? <BookmarkCheck /> : <BookmarkPlus />}
        </IconButton>
      )}
      {children}
    </>
  )
}
