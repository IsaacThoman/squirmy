import { BookmarkCheck, BookmarkPlus, Heart, Play, Shuffle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'

type CollectionHeaderProps = {
  /** "Album", "Playlist", "EP"… */
  kind: string
  title: string
  art: ReactNode
  /** The line under the title: artist links, owner. */
  byline?: ReactNode
  description?: string | null
  meta?: (string | null | undefined | false)[]
  /** The artwork's dominant color; tints the header. */
  tint?: string | null
  actions?: ReactNode
}

/** The top of an album or playlist page, tinted with its artwork's color. */
export function CollectionHeader({ kind, title, art, byline, description, meta, tint, actions }: CollectionHeaderProps) {
  return (
    <header className="px-(--gutter) pb-6 pt-6 md:pb-8 md:pt-8">
      <div
        className="@container rounded-2xl border border-stroke bg-[linear-gradient(115deg,color-mix(in_srgb,var(--collection-color)_16%,var(--sheet)),var(--sheet)_68%)]"
        style={{ '--collection-color': tint ?? 'var(--accent)' } as CSSProperties}
      >
        <div className="flex flex-col items-center gap-5 p-5 text-center @min-[32rem]:flex-row @min-[32rem]:gap-7 @min-[32rem]:p-7 @min-[32rem]:text-left">
          <div className="w-[min(51vw,11rem)] shrink-0 @min-[32rem]:w-44 @min-[55rem]:w-52 [&>*]:shadow-cover">{art}</div>
          <div className="flex min-w-0 flex-col items-center gap-1.5 @min-[32rem]:items-start">
            <p className="text-xs font-semibold uppercase tracking-[0.11em] text-muted">{kind}</p>
            <h1 className="max-w-full text-balance break-words text-[clamp(1.85rem,5.5cqw,3.75rem)] font-extrabold leading-[1.05] tracking-[-0.045em]">{title}</h1>
            {byline && <div className="text-sm font-semibold @min-[32rem]:text-base">{byline}</div>}
            {meta?.some(Boolean) && <p className="text-sm text-muted">{meta.filter(Boolean).join(' · ')}</p>}
            {description && <p className="mt-1 max-w-xl break-words text-sm leading-relaxed text-muted">{description}</p>}
            {actions && <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 @min-[32rem]:justify-start">{actions}</div>}
          </div>
        </div>
      </div>
    </header>
  )
}

type PlayActionsProps = {
  title: string
  onPlay?: () => void
  onShuffle?: () => void
  liked?: boolean
  onLike?: () => void
  wanted?: boolean
  onWant?: () => void
  children?: ReactNode
}

/** Play, Shuffle, Like and Want, with room for an overflow menu. */
export function PlayActions({ title, onPlay, onShuffle, liked, onLike, wanted, onWant, children }: PlayActionsProps) {
  return (
    <>
      <Button variant="primary" aria-label={`Play ${title}`} disabled={!onPlay} onClick={onPlay}>
        <Play fill="currentColor" />Play
      </Button>
      {onShuffle && <IconButton label={`Shuffle ${title}`} size="lg" onClick={onShuffle}><Shuffle /></IconButton>}
      {onLike && (
        <IconButton label={liked ? `Remove ${title} from your library` : `Save ${title} to your library`} size="lg" onClick={onLike} className={cn(liked && 'text-accent hover:text-accent')}>
          <Heart fill={liked ? 'currentColor' : 'none'} />
        </IconButton>
      )}
      {onWant && (
        <IconButton label={wanted ? 'Remove from Wantlist' : 'Add to Wantlist'} size="lg" onClick={onWant} className={cn(wanted && 'text-accent hover:text-accent')}>
          {wanted ? <BookmarkCheck /> : <BookmarkPlus />}
        </IconButton>
      )}
      {children}
    </>
  )
}
