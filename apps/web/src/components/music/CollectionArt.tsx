import type { Artwork } from '@squirmy/contracts'
import { AudioLines, Heart, ListMusic, Radio, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Cover } from './Cover'

const edge = 'pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/10'

/** Up to four covers in a grid; one cover alone fills the square. */
export function PlaylistCover({ artworks, className }: { artworks: Artwork[]; className?: string }) {
  return (
    <Mosaic artworks={artworks} className={className}>
      <GradientArt className={className} colors="from-[#49665F] via-[#324747] to-[#212F3B]">
        <ListMusic aria-hidden strokeWidth={1.8} />
      </GradientArt>
    </Mosaic>
  )
}

/**
 * A mix made for the user: the covers of its first albums, as a playlist's, with its slot
 * ("Mix 1") written across the foot, so mixes tell apart from playlists at a glance. The words
 * scale with the cover, from a card to the page header.
 */
export function MixCover({ artworks, label, className }: { artworks: Artwork[]; label: string; className?: string }) {
  return (
    <div className={cn('@container relative', className)}>
      <Mosaic artworks={artworks}>
        <GradientArt colors="from-[#5E5A7A] via-[#3D3A56] to-[#252338]">
          <AudioLines aria-hidden strokeWidth={1.8} />
        </GradientArt>
      </Mosaic>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-cover bg-linear-to-t from-black/70 via-black/35 to-transparent px-[7cqw] pb-[6cqw] pt-[16cqw] text-[11cqw] font-semibold leading-none tracking-tight text-white">
        {label}
      </span>
    </div>
  )
}

/** A radio: the cover of the song or the artist it started from, with the radio's mark in a corner. */
export function RadioCover({ artwork, round, className }: { artwork: Artwork | null; round?: boolean; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      {artwork
        ? <Cover artwork={artwork} round={round} />
        : (
          <GradientArt colors="from-[#7A5A5E] via-[#563A3D] to-[#382325]" className={cn(round && 'rounded-full')}>
            <Radio aria-hidden strokeWidth={1.8} />
          </GradientArt>
        )}
      {artwork && (
        <span aria-hidden className="absolute left-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm [&_svg]:size-3.5">
          <Radio strokeWidth={2.2} />
        </span>
      )}
    </div>
  )
}

/** Four covers or more in a grid, one alone filling the square, none the fallback (`children`). */
function Mosaic({ artworks, className, children }: { artworks: Artwork[]; className?: string; children: ReactNode }) {
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
  return children
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
