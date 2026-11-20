import type { ArtSize, Artwork } from '@squirmy/contracts'
import { Music2 } from 'lucide-react'
import { useState } from 'react'
import { doubleSize, thumbhashUrl, useArtUrl, type ArtUrlBuilder } from '@/lib/artwork'
import { cn } from '@/lib/utils'

type CoverProps = {
  artwork: Artwork | null
  /** The rendition to fetch; twice this is offered to dense screens. */
  size?: ArtSize
  alt?: string
  round?: boolean
  /** Overrides the app's art URL builder. */
  artUrl?: ArtUrlBuilder
  className?: string
  /** Gray out artwork for music that is not in the library. */
  dimmed?: boolean
}

/**
 * Square artwork. Paints the dominant color and ThumbHash at once, fades the image in over them,
 * and falls back to a note on the theme's surface when there is no art or it fails to load.
 */
export function Cover({ artwork, size = 300, alt = '', round, artUrl, className, dimmed }: CoverProps) {
  const defaultUrl = useArtUrl()
  const url = artUrl ?? defaultUrl
  const placeholder = artwork?.thumbhash ? thumbhashUrl(artwork.thumbhash) : undefined
  return (
    <div
      className={cn(
        'relative aspect-square shrink-0 overflow-hidden bg-surface transition-[filter,opacity] duration-200',
        round ? 'rounded-full' : 'rounded-cover',
        dimmed && 'opacity-55 grayscale',
        className,
      )}
      style={{
        backgroundColor: artwork?.color ?? undefined,
        backgroundImage: placeholder ? `url(${placeholder})` : undefined,
        backgroundSize: 'cover',
      }}
    >
      {artwork
        ? <CoverImage key={artwork.id} src={url(artwork, size)} srcSet={`${url(artwork, size)} 1x, ${url(artwork, doubleSize(size))} 2x`} alt={alt} />
        : <Fallback />}
      <div aria-hidden className={cn('pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_var(--stroke)]', round ? 'rounded-full' : 'rounded-cover')} />
    </div>
  )
}

function CoverImage({ src, srcSet, alt }: { src: string; srcSet: string; alt: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (status === 'failed') return <Fallback />
  return (
    <img
      ref={image => { if (image?.complete && image.naturalWidth) setStatus('loaded') }}
      src={src}
      srcSet={srcSet}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus('failed')}
      className={cn('absolute inset-0 size-full object-cover transition-opacity duration-200', status === 'loaded' ? 'opacity-100' : 'opacity-0')}
    />
  )
}

function Fallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-linear-145 from-surface to-[color-mix(in_srgb,var(--surface),var(--foreground)_8%)] text-quiet">
      <Music2 aria-hidden className="size-[30%] max-h-16 max-w-16" strokeWidth={1.6} />
    </div>
  )
}
