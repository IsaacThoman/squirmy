import { cachedFetch, ProviderError, request, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** Downloaded image bytes. */
export type FetchedImage = { bytes: Buffer; contentType: string }

type RawListing = {
  images: {
    front: boolean
    approved?: boolean
    image: string
    thumbnails: Record<string, string | undefined>
  }[]
}

const provider = 'coverart'
const listingTtl = 7 * 86400
const defaultMaxBytes = 20 * 1024 * 1024

/** The front cover of a release at about 1200 px, or null when it has none. */
export function getReleaseCover(releaseMbid: string): Promise<string | null> {
  return frontCover('release', releaseMbid)
}

/** The cover the Cover Art Archive picked for a release group, at about 1200 px, or null. */
export function getReleaseGroupCover(releaseGroupMbid: string): Promise<string | null> {
  return frontCover('release-group', releaseGroupMbid)
}

/**
 * Reads the archive's JSON listing, which names each rendition's URL directly, so the
 * image redirect does not have to be followed until the image is downloaded.
 */
async function frontCover(entity: 'release' | 'release-group', mbid: string): Promise<string | null> {
  const settings = await getServerSettings()
  if (!settings.coverArtArchiveEnabled) return null
  const result = await cachedFetch(provider, `https://coverartarchive.org/${entity}/${mbid}`, {
    ttlSeconds: listingTtl,
    headers: { Accept: 'application/json' },
  })
  if (result.status === 404 || result.status === 400) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  const front = (result.json as RawListing).images.find((image) => image.front)
  if (!front) return null
  const url = front.thumbnails['1200'] ?? front.thumbnails.large ?? front.image
  return url.replace(/^http:/, 'https:')
}

/**
 * Downloads an image for any provider. Null when the URL is gone, is not an image, or
 * exceeds `maxBytes` (default 20 MB); network failures and 5xx throw ProviderError.
 */
export async function fetchImage(url: string, options: { maxBytes?: number } = {}): Promise<FetchedImage | null> {
  const maxBytes = options.maxBytes ?? defaultMaxBytes
  const response = await request('image', url, { headers: { Accept: 'image/*' }, timeoutMs: 30_000 })
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) throw new ProviderError('image', `HTTP ${response.status} for ${url}`, response.status)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!contentType.startsWith('image/') || Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    return null
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    // Leaving the loop cancels the stream.
    if (size > maxBytes) return null
    chunks.push(Buffer.from(chunk))
  }
  return { bytes: Buffer.concat(chunks), contentType }
}
