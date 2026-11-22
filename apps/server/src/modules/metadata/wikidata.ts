import { cachedFetch, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** An image from Wikimedia Commons. Show `pageUrl` for attribution; licenses vary per file. */
export type WikidataImage = {
  /** Special:FilePath URL that redirects to a rendition `width` pixels wide. */
  url: string
  fileName: string
  /** The Commons file page, which states author and license. */
  pageUrl: string
}

/** The lead section of an English Wikipedia article. */
export type WikipediaSummary = {
  title: string
  text: string
  /** The article, for "Read more on Wikipedia". */
  sourceUrl: string
  /** Attribution to show with the text. */
  license: string
}

type Claim = { rank?: 'preferred' | 'normal' | 'deprecated'; mainsnak?: { datavalue?: { value?: unknown } } }

const ttl = 7 * 86400
const wikidataApi = 'https://www.wikidata.org/w/api.php'
const license = 'Text from Wikipedia, available under CC BY-SA 4.0.'

async function getJson<T>(provider: string, url: string): Promise<T | null> {
  const result = await cachedFetch(provider, url, { ttlSeconds: ttl, headers: { Accept: 'application/json' } })
  if (result.status === 404) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  return result.json as T
}

async function enabled(qid: string): Promise<boolean> {
  return /^Q\d+$/.test(qid) && (await getServerSettings()).wikidataEnabled
}

/** The entity's image (P18), preferring a preferred-rank statement. Null when it has none. */
export async function getImage(qid: string, options: { width?: number } = {}): Promise<WikidataImage | null> {
  if (!(await enabled(qid))) return null
  const url = `${wikidataApi}?action=wbgetclaims&format=json&entity=${qid}&property=P18`
  const data = await getJson<{ claims?: { P18?: Claim[] } }>('wikidata', url)
  const claims = (data?.claims?.P18 ?? []).filter((claim) => claim.rank !== 'deprecated')
  const claim = claims.find((one) => one.rank === 'preferred') ?? claims[0]
  const fileName = claim?.mainsnak?.datavalue?.value
  if (typeof fileName !== 'string') return null
  const path = encodeURIComponent(fileName.replace(/ /g, '_'))
  return {
    url: `https://commons.wikimedia.org/wiki/Special:FilePath/${path}?width=${options.width ?? 1000}`,
    fileName,
    pageUrl: `https://commons.wikimedia.org/wiki/File:${path}`,
  }
}

/** The English Wikipedia summary for the entity, or null without an article (or for a disambiguation page). */
/**
 * Wikipedia's summary drops parentheticals (pronunciations, roles) but leaves their
 * separators: "Thom Yorke ; brothers …", "( ; )". Migration 0020_artist_read_model applies
 * the same cleanup to stored bios.
 */
export function cleanExtract(text: string): string {
  return text
    .replace(/\(\s*[;,]?\s*\)/g, '')
    .replace(/\(\s*[;,]\s*/g, '(')
    .replace(/\s+([;,])/g, '$1')
    .replace(/\s+\.(\s|$)/g, '.$1')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export async function getWikipediaSummary(qid: string): Promise<WikipediaSummary | null> {
  if (!(await enabled(qid))) return null
  const url = `${wikidataApi}?action=wbgetentities&format=json&ids=${qid}&props=sitelinks&sitefilter=enwiki`
  const data = await getJson<{ entities?: Record<string, { sitelinks?: { enwiki?: { title: string } } }> }>('wikidata', url)
  const title = data?.entities?.[qid]?.sitelinks?.enwiki?.title
  if (!title) return null
  const summary = await getJson<{ type?: string; title: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
    'wikipedia',
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
  )
  if (!summary?.extract || summary.type === 'disambiguation') return null
  return {
    title: summary.title,
    text: cleanExtract(summary.extract),
    sourceUrl: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    license,
  }
}
