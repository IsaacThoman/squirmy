import type { ArtSize, Artwork } from '@squirmy/contracts'
import { Music2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { doubleSize, loadedArtUrl, rememberLoadedArt, thumbhashUrl, useArtUrl, type ArtUrlBuilder } from '@/lib/artwork'
import { cn } from '@/lib/utils'
import { useCrossfade } from './use-crossfade'

/** How long a cover takes to fade over the one before when `crossfade` is set, in ms. */
const crossfadeMs = 360

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
  /**
   * For artwork that changes in place (the player's, as the track changes): the cover before
   * stays until the new one has loaded and faded up over it, so there is never a frame of the
   * placeholder in between.
   */
  crossfade?: boolean
}

/**
 * Square artwork. Paints the dominant color and ThumbHash at once (or a size of the same art
 * shown before, such as a card's cover on the album page), fades the image in over them, and
 * falls back to a note on the theme's quiet fill when there is no art or it fails to load.
 */
export function Cover({ artwork, size = 300, alt = '', round, artUrl, className, dimmed, crossfade }: CoverProps) {
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
      {crossfade
        ? <CrossfadeImages artwork={artwork} size={size} url={url} alt={alt} />
        : artwork
          ? <CoverImage key={artwork.id} artworkId={artwork.id} src={url(artwork, size)} srcSet={srcSet(url, artwork, size)} alt={alt} />
          : <Fallback />}
      {/* A hairline that keeps pale artwork apart from the page; it follows whatever corners the cover has. */}
      <div aria-hidden data-edge className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-foreground/10" />
    </div>
  )
}

const srcSet = (url: ArtUrlBuilder, artwork: Artwork, size: ArtSize) => `${url(artwork, size)} 1x, ${url(artwork, doubleSize(size))} 2x`

/** The covers a changing `Cover` draws: the one before under the one coming in, until it is up. */
function CrossfadeImages({ artwork, size, url, alt }: { artwork: Artwork | null; size: ArtSize; url: ArtUrlBuilder; alt: string }) {
  const { layers, fading, shown } = useCrossfade(artwork, crossfadeMs)
  return layers.map((layer, index) => {
    const top = index === layers.length - 1
    if (!layer) return <Fallback key="none" />
    return (
      <CoverImage
        key={layer.id}
        artworkId={layer.id}
        src={url(layer, size)}
        srcSet={srcSet(url, layer, size)}
        alt={top ? alt : ''}
        slow={fading && top}
        onShown={top ? () => shown(layer.id) : undefined}
      />
    )
  })
}

function CoverImage({ artworkId, src, srcSet, alt, slow, onShown }: { artworkId: string; src: string; srcSet: string; alt: string; slow?: boolean; onShown?: () => void }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (status === 'failed') return <Fallback onShown={onShown} />
  const shown = (image: HTMLImageElement) => {
    rememberLoadedArt(artworkId, image.currentSrc)
    setStatus('loaded')
    onShown?.()
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
      className={cn('absolute inset-0 size-full object-cover transition-opacity', slow ? 'duration-[360ms] ease-out' : 'duration-200', status === 'loaded' ? 'opacity-100' : 'opacity-0')}
    />
  )
}

function Fallback({ onShown }: { onShown?: () => void }) {
  // A cover that failed is as far as it goes: the one under it can go.
  useEffect(() => { onShown?.() }, [onShown])
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground/70">
      <Music2 aria-hidden className="size-[30%] max-h-14 max-w-14" strokeWidth={1.5} />
    </div>
  )
}
