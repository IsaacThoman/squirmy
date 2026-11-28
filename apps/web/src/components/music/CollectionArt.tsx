import type { Artwork } from '@squirmy/contracts'
import { Heart, ListMusic, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Cover } from './Cover'

const edge = 'pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/10'

/** Up to four covers in a grid; one cover alone fills the square. */
export function PlaylistCover({ artworks, className }: { artworks: Artwork[]; className?: string }) {
  if (artworks.length >= 4) {
    return (
      // One hairline around the mosaic instead of one around each of its covers.
      <div className={cn('relative grid aspect-square shrink-0 grid-cols-2 overflow-hidden rounded-cover [&>*>[data-edge]]:hidden', className)}>
        {artworks.slice(0, 4).map(artwork => <Cover key={artwork.id} artwork={artwork} size={300} className="rounded-none" />)}
        <span aria-hidden className={edge} />
      </div>
    )
  }
  if (artworks.length) return <Cover artwork={artworks[0]} className={className} />
  return (
    <GradientArt className={className} colors="from-[#49665F] via-[#324747] to-[#212F3B]">
      <ListMusic aria-hidden strokeWidth={1.8} />
    </GradientArt>
  )
}

/**
 * The theme's action color as a gradient for Liked Songs: lifted toward white at the top left, held
 * toward black below, so the white heart reads on it in every theme and appearance.
 */
export const likedGradient = 'from-[color-mix(in_oklab,var(--primary)_72%,white)] via-[color-mix(in_oklab,var(--primary)_68%,black)] to-[color-mix(in_oklab,var(--primary)_38%,black)]'

/** The tint of the Liked Songs page, the middle of its cover's gradient. */
export const likedTint = 'color-mix(in oklab, var(--primary) 68%, black)'

/** The Liked Songs cover: the theme's color, rings and a heart. */
export function LikedCover({ className }: { className?: string }) {
  return (
    <GradientArt className={className} colors={likedGradient}>
      <Heart aria-hidden fill="currentColor" strokeWidth={0} />
    </GradientArt>
  )
}

/**
 * Art for collections that have no covers of their own. It is drawn from 24px in the sidebar to a
 * page header, so the rings only appear once there is room and the icon is larger while there is not.
 */
function GradientArt({ colors, className, children }: { colors: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('@container relative flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-cover bg-linear-135 text-[#FFF8FF]', colors, className)}>
      <span aria-hidden className="absolute hidden size-3/4 rounded-full border border-[#FFF8FF40] @[4rem]:block" />
      <span aria-hidden className="absolute hidden size-[54%] rounded-full border border-[#FFF8FF40] @[4rem]:block" />
      <span className="relative flex size-1/2 items-center justify-center @[4rem]:size-[28%] [&_svg]:size-full">{children}</span>
      <span aria-hidden className={edge} />
    </div>
  )
}

/** The mark of a smart playlist beside its name or kind: its songs come from rules. Words beside it say so to screen readers. */
export function SmartMark({ className }: { className?: string }) {
  return <Sparkles aria-hidden className={cn('shrink-0', className)} />
}
