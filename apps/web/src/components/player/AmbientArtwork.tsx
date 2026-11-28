import type { Artwork } from '@squirmy/contracts'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { thumbHashToRGBA } from 'thumbhash'
import { useCrossfade } from '@/components/music/use-crossfade'
import { AMBIENT_HOLD, saturatePixels } from '@/lib/ambient'
import { useAppearance } from '@/lib/appearance'
import { useArtUrl, type ArtUrlBuilder } from '@/lib/artwork'
import { cn } from '@/lib/utils'
import './ambient.css'

/** The colors fade from one song's to the next's over this long, in ms (as on the Apple TV). */
const fadeMs = 900
/** The side of the picture the backdrop is drawn from, in pixels, for a cover without a ThumbHash. */
const drawnSide = 24

/**
 * The cover's colors at a few dozen pixels, made more colorful: its ThumbHash, which is already
 * a blur of the cover, or for a cover without one, the cover drawn that small. Null until drawn.
 */
function useAmbientPixels(artwork: Artwork, artUrl: ArtUrlBuilder): ImageData | null {
  const [drawn, setDrawn] = useState<{ id: string; pixels: ImageData } | null>(null)
  const hash = artwork.thumbhash
  const fromHash = useMemo(() => {
    if (!hash || typeof ImageData === 'undefined') return null
    try {
      const { w, h, rgba } = thumbHashToRGBA(Uint8Array.from(atob(hash), char => char.charCodeAt(0)))
      const pixels = new Uint8ClampedArray(rgba)
      saturatePixels(pixels)
      return new ImageData(pixels, w, h)
    } catch {
      return null
    }
  }, [hash])
  const needsDrawing = !fromHash && drawn?.id !== artwork.id
  useEffect(() => {
    if (!needsDrawing) return
    let live = true
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (!live) return
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = drawnSide
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.drawImage(image, 0, 0, drawnSide, drawnSide)
      try {
        const pixels = context.getImageData(0, 0, drawnSide, drawnSide)
        saturatePixels(pixels.data)
        setDrawn({ id: artwork.id, pixels })
      } catch {
        // An image from another origin cannot be read back; the cover's color stands in.
      }
    }
    image.src = artUrl(artwork, 96)
    return () => { live = false }
  }, [needsDrawing, artwork, artUrl])
  return fromHash ?? (drawn?.id === artwork.id ? drawn.pixels : null)
}

/** A canvas of the cover's few dozen pixels. The browser scales it up smoothly: that is the blur. */
function AmbientCanvas({ pixels, className }: { pixels: ImageData; className: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    element.width = pixels.width
    element.height = pixels.height
    element.getContext('2d')?.putImageData(pixels, 0, 0)
  }, [pixels])
  return <canvas ref={canvas} aria-hidden className={className} />
}

function subscribeToVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * One song's backdrop: its colors, turning, over its dominant color, which shows at once. It
 * fades in over the song before it (`fading`).
 */
function AmbientLayer({ artwork, fading }: { artwork: Artwork; fading: boolean }) {
  const artUrl = useArtUrl()
  const pixels = useAmbientPixels(artwork, artUrl)
  return (
    <div className={cn('ambient-layer', fading && 'ambient-fade')} style={{ backgroundColor: artwork.color ?? undefined, ['--ambient-fade' as string]: `${fadeMs}ms` }}>
      {pixels && (
        <>
          <AmbientCanvas pixels={pixels} className="ambient-turn ambient-turn-forward" />
          <AmbientCanvas pixels={pixels} className="ambient-turn ambient-turn-back" />
        </>
      )}
    </div>
  )
}

/**
 * Now Playing's backdrop, as on the Apple TV (`tv/player/Ambience.tsx`): the cover's colors
 * spread across the screen, blurred past recognition, in two layers turning slowly against
 * each other, held toward the theme's background so its text reads over any cover
 * (`AMBIENT_HOLD`, checked in color-themes.test.ts).
 *
 * It is cheap to draw: each layer is a canvas of a few dozen pixels (the ThumbHash) that the
 * compositor scales up and turns, so no blur or other filter runs, and nothing is painted while
 * it moves. It stops turning while the music is paused or the page is hidden, and stands still
 * under reduced motion. A new song's colors fade in over the last song's.
 */
export function AmbientArtwork({ artwork, playing, className }: { artwork: Artwork | null; playing: boolean; className?: string }) {
  const { layers, fading, shown } = useCrossfade(artwork, fadeMs)
  // The new song's color is there at once, so its fade starts now.
  const id = artwork?.id ?? null
  useEffect(() => { shown(id) }, [id, shown])
  const hidden = useSyncExternalStore(subscribeToVisibility, () => document.hidden, () => false)
  const { opacity, shade } = AMBIENT_HOLD[useAppearance().resolved]
  return (
    <div aria-hidden data-turning={playing && !hidden} className={cn('ambient', className)}>
      <div className="absolute inset-0" style={{ opacity }}>
        {layers.map((layer, index) => layer
          ? <AmbientLayer key={layer.id} artwork={layer} fading={fading && index === layers.length - 1} />
          : <div key="none" className={cn('ambient-layer', fading && 'ambient-fade')} />)}
        {shade > 0 && <div className="ambient-shade bg-black" style={{ opacity: shade }} />}
      </div>
    </div>
  )
}
