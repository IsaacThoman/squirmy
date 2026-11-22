import { ProviderError, request } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** Downloaded image bytes. */
export type FetchedImage = { bytes: Buffer; contentType: string }

const defaultMaxBytes = 20 * 1024 * 1024

const within = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`)

/**
 * Whether the source an image URL belongs to is switched on. Images are listed lazily
 * (see `remoteImage`) and downloaded when first viewed, possibly after the admin turned
 * their source off; that download is a request to the source too. Hosts no source owns
 * are allowed.
 */
export async function imageSourceEnabled(url: string): Promise<boolean> {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  const settings = await getServerSettings()
  // The Cover Art Archive redirects its images to archive.org.
  if (within(hostname, 'coverartarchive.org') || within(hostname, 'archive.org')) return settings.coverArtArchiveEnabled
  if (within(hostname, 'dzcdn.net') || within(hostname, 'deezer.com')) return settings.deezerEnabled
  if (within(hostname, 'fanart.tv')) return settings.fanartKeySet
  if (within(hostname, 'wikimedia.org') || within(hostname, 'wikipedia.org') || within(hostname, 'wikidata.org')) return settings.wikidataEnabled
  return true
}

/**
 * Downloads an image for any provider. Null when the URL is gone, is not an image,
 * exceeds `maxBytes` (default 20 MB), or belongs to a source that is switched off;
 * network failures and 5xx throw ProviderError.
 */
export async function fetchImage(url: string, options: { maxBytes?: number } = {}): Promise<FetchedImage | null> {
  return (await downloadImage(url, options)).image
}

/**
 * `fetchImage`, also saying whether the server answered that there is no such image
 * (404 or 410), as the Cover Art Archive does for a release group without a cover. A
 * source that is switched off is asked nothing and is not "gone".
 */
export async function downloadImage(url: string, options: { maxBytes?: number } = {}): Promise<{ image: FetchedImage | null; gone: boolean }> {
  if (!(await imageSourceEnabled(url))) return { image: null, gone: false }
  const maxBytes = options.maxBytes ?? defaultMaxBytes
  const response = await request('image', url, { headers: { Accept: 'image/*' }, timeoutMs: 30_000 })
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel()
    return { image: null, gone: true }
  }
  if (!response.ok) throw new ProviderError('image', `HTTP ${response.status} for ${url}`, response.status)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!contentType.startsWith('image/') || Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    return { image: null, gone: false }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    // Leaving the loop cancels the stream.
    if (size > maxBytes) return { image: null, gone: false }
    chunks.push(Buffer.from(chunk))
  }
  return { image: { bytes: Buffer.concat(chunks), contentType }, gone: false }
}
