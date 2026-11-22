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
  /** A small rendition of the artwork, blurred behind the header. */
  backdrop?: string
}

/** The top of an album or playlist page, tinted with its artwork's color. */
export function CollectionHeader({ kind, title, art, byline, meta, tint, actions, backdrop }: CollectionHeaderProps) {
  return (
    <header className={cn('relative isolate overflow-hidden px-(--gutter) pb-6 pt-20 md:pt-24', tint && 'album-tint')} style={tint ? { '--tint': tint } as CSSProperties : undefined}>
      {backdrop && (
        <img
          aria-hidden
          src={backdrop}
          alt=""
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full w-full scale-110 object-cover opacity-[calc(var(--album-tint)*1.1)] blur-3xl saturate-150 [mask-image:linear-gradient(to_bottom,black_30%,transparent)]"
        />
      )}
      <div className="flex flex-col items-center gap-6 text-center md:flex-row md:items-end md:gap-9 md:text-left">
        <div className="w-[min(64vw,16rem)] shrink-0 md:w-56 lg:w-64 xl:w-72 [&>*]:shadow-[0_28px_56px_-16px_hsl(var(--shadow-color)/0.55)]">{art}</div>
        <div className="flex min-w-0 flex-col items-center gap-2 md:items-start md:pb-1">
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-accent">{kind}</span>
          <h1 className="text-balance text-[clamp(2rem,4.8vw,4.5rem)] font-extrabold leading-[1] tracking-[-0.045em]">{title}</h1>
          {byline && <div className="text-[17px] font-semibold">{byline}</div>}
          {meta?.some(Boolean) && <p className="text-[13px] font-medium text-muted">{meta.filter(Boolean).join(' · ')}</p>}
          {actions && <div className="mt-4 flex items-center justify-center gap-2 md:justify-start">{actions}</div>}
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
