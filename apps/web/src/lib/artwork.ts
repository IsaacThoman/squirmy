import { API_PREFIX, ART_SIZES, type ArtSize, type Artwork } from '@squirmy/contracts'
import { createContext, useContext } from 'react'
import { thumbHashToDataURL } from 'thumbhash'

export type ArtUrlBuilder = (artwork: Artwork, size: ArtSize) => string

// The extension lets a CDN in front of the server cache renditions (Cloudflare caches by extension).
export const apiArtUrl: ArtUrlBuilder = (artwork, size) => `${API_PREFIX}/art/${artwork.id}/${size}.webp`

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

const loaded = new Map<string, string>()

/** Notes a rendition the browser has shown, so a larger one can start from it. */
export function rememberLoadedArt(artworkId: string, url: string) {
  if (url) loaded.set(artworkId, url)
}

/** A rendition of this artwork already in the browser's cache, to show while another size loads. */
export function loadedArtUrl(artworkId: string): string | undefined {
  return loaded.get(artworkId)
}
