import { cachedFetch, ProviderError } from '../../lib/http.js'
import { getServerSecret, getServerSettings } from '../../lib/settings.js'

/** Artist artwork from fanart.tv, each list most-liked first. */
export type FanartArtistImages = {
  /** Square-ish portraits (1000×1000). */
  thumbnails: string[]
  /** Wide backdrops (1920×1080). */
  backgrounds: string[]
}

type RawImage = { url: string; likes?: string }
type RawArtist = { artistthumb?: RawImage[]; artistbackground?: RawImage[] }

const provider = 'fanart'
const ttl = 7 * 86400

function byLikes(images: RawImage[] | undefined): string[] {
  return [...(images ?? [])].sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0)).map((image) => image.url)
}

/** Thumbnails and backgrounds for a MusicBrainz artist. Null without a key or when fanart.tv has nothing. */
export async function getArtistImages(artistMbid: string): Promise<FanartArtistImages | null> {
  if (!(await getServerSettings()).fanartKeySet) return null
  const key = await getServerSecret('fanartKey')
  if (!key) return null
  const result = await cachedFetch(provider, `https://webservice.fanart.tv/v3/music/${artistMbid}?api_key=${encodeURIComponent(key)}`, {
    ttlSeconds: ttl,
    headers: { Accept: 'application/json' },
  })
  if (result.status === 404) return null
  if (result.status !== 200) {
    const message = (result.json as { 'error message'?: string } | undefined)?.['error message'] ?? `HTTP ${result.status}`
    throw new ProviderError(provider, message, result.status)
  }
  const raw = result.json as RawArtist
  const images = { thumbnails: byLikes(raw.artistthumb), backgrounds: byLikes(raw.artistbackground) }
  return images.thumbnails.length || images.backgrounds.length ? images : null
}
