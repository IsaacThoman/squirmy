import type { ArtSize, Artwork } from '@squirmy/contracts'
import { Music2 } from 'lucide-react'
import { useState } from 'react'
import { doubleSize, loadedArtUrl, rememberLoadedArt, thumbhashUrl, useArtUrl, type ArtUrlBuilder } from '@/lib/artwork'
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
 * Square artwork. Paints the dominant color and ThumbHash at once (or a size of the same art
 * shown before, such as a card's cover on the album page), fades the image in over them, and
 * falls back to a note on the theme's quiet fill when there is no art or it fails to load.
 */
export function Cover({ artwork, size = 300, alt = '', round, artUrl, className, dimmed }: CoverProps) {
  const defaultUrl = useArtUrl()
  const url = artUrl ?? defaultUrl
  const placeholder = artwork ? loadedArtUrl(artwork.id) ?? (artwork.thumbhash ? thumbhashUrl(artwork.thumbhash) : undefined) : undefined
  return (
    <div
      className={cn(
        'relative aspect-square shrink-0 overflow-hidden bg-muted transition-[filter,opacity] duration-200',
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
        ? <CoverImage key={artwork.id} artworkId={artwork.id} src={url(artwork, size)} srcSet={`${url(artwork, size)} 1x, ${url(artwork, doubleSize(size))} 2x`} alt={alt} />
        : <Fallback />}
      {/* A hairline that keeps pale artwork apart from the page; it follows whatever corners the cover has. */}
      <div aria-hidden data-edge className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/10" />
    </div>
  )
}

function CoverImage({ artworkId, src, srcSet, alt }: { artworkId: string; src: string; srcSet: string; alt: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (status === 'failed') return <Fallback />
  const shown = (image: HTMLImageElement) => {
    rememberLoadedArt(artworkId, image.currentSrc)
    setStatus('loaded')
  }
  return (
    <img
      ref={image => { if (image?.complete && image.naturalWidth) shown(image) }}
      src={src}
      srcSet={srcSet}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={event => shown(event.currentTarget)}
      onError={() => setStatus('failed')}
      className={cn('absolute inset-0 size-full object-cover transition-opacity duration-200', status === 'loaded' ? 'opacity-100' : 'opacity-0')}
    />
  )
}

function Fallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground/70">
      <Music2 aria-hidden className="size-[30%] max-h-14 max-w-14" strokeWidth={1.5} />
    </div>
  )
}
