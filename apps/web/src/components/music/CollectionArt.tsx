import type { Artwork } from '@squirmy/contracts'
import { Heart, ListMusic } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Cover } from './Cover'

/** Up to four covers in a grid; one cover alone fills the square. */
export function PlaylistCover({ artworks, className }: { artworks: Artwork[]; className?: string }) {
  if (artworks.length >= 4) {
    return (
      <div className={cn('grid aspect-square shrink-0 grid-cols-2 overflow-hidden rounded-cover', className)}>
        {artworks.slice(0, 4).map(artwork => <Cover key={artwork.id} artwork={artwork} size={300} className="rounded-none" />)}
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

/** The Liked Songs cover from the iOS app: a purple gradient, rings and a heart. */
export function LikedCover({ className }: { className?: string }) {
  return (
    <GradientArt className={className} colors="from-[#C6B4FA] via-[#7862B4] to-[#30274A]">
      <Heart aria-hidden fill="currentColor" strokeWidth={0} />
    </GradientArt>
  )
}

function GradientArt({ colors, className, children }: { colors: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('@container relative flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-cover bg-linear-135 text-[#FFF8FF] [&_svg]:size-[28%]', colors, className)}>
      <span aria-hidden className="absolute size-3/4 rounded-full border border-[#FFF8FF50]" />
      <span aria-hidden className="absolute size-[57%] rounded-full border border-[#FFF8FF50]" />
      {children}
    </div>
  )
}
