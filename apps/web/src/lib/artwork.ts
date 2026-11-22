import { artworkUrl } from '@squirmy/client-core'
import { ART_SIZES, type ArtSize, type Artwork } from '@squirmy/contracts'
import { createContext, useContext } from 'react'
import { thumbHashToDataURL } from 'thumbhash'

export type ArtUrlBuilder = (artwork: Artwork, size: ArtSize) => string

// Same origin, so the path alone; artworkUrl is the one place that knows the route.
export const apiArtUrl: ArtUrlBuilder = (artwork, size) => artworkUrl('', artwork, size)!

/** How `Cover` turns artwork into an image URL. Defaults to the server's art route. */
export const ArtUrlContext = createContext<ArtUrlBuilder>(apiArtUrl)

export function useArtUrl() {
  return useContext(ArtUrlContext)
}

const placeholders = new Map<string, string>()

/** Decodes a base64 ThumbHash into a tiny data URL, once per hash. */
export function thumbhashUrl(hash: string): string | undefined {
  let url = placeholders.get(hash)
  if (url === undefined) {
    try {
      url = thumbHashToDataURL(Uint8Array.from(atob(hash), char => char.charCodeAt(0)))
    } catch {
      url = ''
    }
    placeholders.set(hash, url)
  }
  return url || undefined
}

/** The next size up, for high-density screens. */
export function doubleSize(size: ArtSize): ArtSize {
  return ART_SIZES[Math.min(ART_SIZES.indexOf(size) + 1, ART_SIZES.length - 1)]!
}
