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
