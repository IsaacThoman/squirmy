import { cachedFetch, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

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

const sizedFront = /^(https:\/\/coverartarchive\.org\/(?:release|release-group)\/[0-9a-f-]{36}\/front)-(?:250|500|1200)$/i

/**
 * The original front image for a sized one (`/release-group/<mbid>/front-500` gives
 * `.../front`), or null for any other URL. The archive redirects a sized image to a
 * thumbnail archive.org derives some time after the upload; until it has, the thumbnail
 * answers 404 while the original is already there, which is the case for most releases of
 * the last few days.
 */
export function originalFront(url: string): string | null {
  return sizedFront.exec(url)?.[1] ?? null
}
