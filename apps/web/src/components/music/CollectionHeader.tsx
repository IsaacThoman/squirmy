import { BookmarkCheck, BookmarkPlus, Heart, Play, Shuffle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'

type CollectionHeaderProps = {
  /** "Album", "Playlist", "EP"… */
  kind: string
  title: string
  art: ReactNode
  /** The line under the title: artist links, owner. */
  byline?: ReactNode
  meta?: (string | null | undefined | false)[]
  /** The artwork's dominant color; tints the header. */
  tint?: string | null
  actions?: ReactNode
}

/** The top of an album or playlist page, tinted with its artwork's color. */
export function CollectionHeader({ kind, title, art, byline, meta, tint, actions }: CollectionHeaderProps) {
  return (
    <header className={cn('px-(--gutter) pb-6 pt-20 md:pt-24', tint && 'album-tint')} style={tint ? { '--tint': tint } as CSSProperties : undefined}>
      <div className="flex flex-col items-center gap-6 text-center md:flex-row md:items-end md:gap-8 md:text-left">
        <div className="w-[min(62vw,15rem)] shrink-0 shadow-cover md:w-52 lg:w-60 [&>*]:shadow-cover">{art}</div>
        <div className="flex min-w-0 flex-col items-center gap-2 md:items-start">
          <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted">{kind}</span>
          <h1 className="text-balance text-[clamp(2rem,4.6vw,4.25rem)] font-extrabold leading-[1.02] tracking-[-0.045em]">{title}</h1>
          {byline && <div className="text-[17px] font-semibold">{byline}</div>}
          {meta?.some(Boolean) && <p className="text-[13px] font-medium text-muted">{meta.filter(Boolean).join(' · ')}</p>}
        </div>
      </div>
      {actions && <div className="mt-7 flex items-center justify-center gap-2 md:justify-start">{actions}</div>}
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
      <IconButton label={`Play ${title}`} variant="accent" size="xl" disabled={!onPlay} onClick={onPlay}>
        <Play className="translate-x-0.5" fill="currentColor" />
      </IconButton>
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
