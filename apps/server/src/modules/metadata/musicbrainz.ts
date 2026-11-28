import type { AlbumType, CreditRole } from '@squirmy/contracts'
import { cachedFetch, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** One artist in a credit. `name` is the name as credited, which may differ from the artist's own. */
export type MbArtistCredit = { name: string; mbid: string; joinPhrase: string }

/** A partial ISO date as MusicBrainz knows it: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
export type MbDate = { date: string | null; year: number | null }

/** A link from an entity to an external page, e.g. `{ type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q44190' }`. */
export type MbUrl = { type: string; url: string }

export type MbArtistSummary = {
  mbid: string
  name: string
  sortName: string
  disambiguation: string
  /** Person, Group, Orchestra, Choir, Character, Other, or null. */
  type: string | null
  country: string | null
  /** Search relevance 0–100; absent outside searches. */
  score?: number
}

export type MbArtist = MbArtistSummary & {
  area: string | null
  lifeSpan: { begin: string | null; end: string | null; ended: boolean }
  aliases: { name: string; sortName: string; locale: string | null; primary: boolean; type: string | null }[]
  /** Most-voted first. */
  genres: { name: string; count: number }[]
  urls: MbUrl[]
  /** Q-id from the wikidata url relation, for wikidata.ts. */
  wikidataId: string | null
}

export type MbReleaseGroupSummary = MbDate & {
  mbid: string
  title: string
  /** Squirmy's album type, derived from the primary and secondary types. */
  type: AlbumType
  primaryType: string | null
  secondaryTypes: string[]
  disambiguation: string
  artistCredit: MbArtistCredit[]
  /** The credit as one string, e.g. "Mark Ronson feat. Bruno Mars". */
  artistName: string
  score?: number
}

export type MbReleaseSummary = MbDate & {
  mbid: string
  title: string
  /** Lowercase: official, promotion, bootleg, pseudo-release, or null. */
  status: string | null
  country: string | null
  barcode: string | null
  disambiguation: string
  artistCredit: MbArtistCredit[]
  artistName: string
  media: { format: string | null; trackCount: number }[]
  trackCount: number
  labels: MbLabel[]
  /** Present when the response included it (searches, recording lookups). */
  releaseGroup: MbReleaseGroupSummary | null
  score?: number
}

export type MbLabel = { name: string | null; mbid: string | null; catalogNumber: string | null }

type MbRelationshipCredit = MbArtistCredit & { role: CreditRole; instrument?: string }
type MbWork = { mbid: string; title: string; movementName?: string; movementNumber?: number }

export type MbRecordingSummary = {
  mbid: string
  title: string
  durationMs: number | null
  disambiguation: string
  video: boolean
  artistCredit: MbArtistCredit[]
  artistName: string
  isrcs: string[]
  relationshipCredits?: MbRelationshipCredit[]
  works?: MbWork[]
}

export type MbRecording = MbRecordingSummary & MbDate & {
  /** Releases the recording appears on, each with its release group. */
  releases: MbReleaseSummary[]
  score?: number
}

export type MbTrack = {
  /** The track id (not the recording id). */
  mbid: string
  /** 1-based position on the medium. */
  position: number
  /** As printed, e.g. "A1". */
  number: string
  title: string
  durationMs: number | null
  artistCredit: MbArtistCredit[]
  artistName: string
  recording: MbRecordingSummary
}

export type MbMedium = { position: number; format: string | null; title: string; tracks: MbTrack[] }

export type MbRelease = Omit<MbReleaseSummary, 'releaseGroup' | 'score'> & {
  releaseGroup: MbReleaseGroupSummary
  urls: MbUrl[]
  mediums: MbMedium[]
}

export type MbReleaseGroup = MbReleaseGroupSummary & {
  genres: { name: string; count: number }[]
  urls: MbUrl[]
  /** Every release in the group, with media and labels but no track lists. */
  releases: MbReleaseSummary[]
}

/** What a URL is linked to in MusicBrainz. */
export type MbUrlLinks = {
  url: string
  artists: { mbid: string; name: string }[]
  releaseGroups: { mbid: string; title: string }[]
  releases: { mbid: string; title: string }[]
  recordings: { mbid: string; title: string }[]
}

type RawCredit = { name: string; joinphrase?: string; artist: { id: string; name: string } }
type RawRelation = {
  type: string
  'target-type'?: string
  url?: { resource: string }
  artist?: { id: string; name: string }
  release?: { id: string; title: string }
  'release-group'?: { id: string; title: string }
  recording?: { id: string; title: string }
  work?: RawWork
  direction?: string
  attributes?: string[]
  'ordering-key'?: number
  'target-credit'?: string
}
type RawWork = { id: string; title: string; relations?: RawRelation[] }
type RawGenre = { name: string; count?: number }
type RawArtist = {
  id: string
  name: string
  'sort-name'?: string
  disambiguation?: string
  type?: string | null
  country?: string | null
  area?: { name: string } | null
  'life-span'?: { begin?: string | null; end?: string | null; ended?: boolean | null }
  aliases?: { name: string; 'sort-name'?: string; locale?: string | null; primary?: boolean | null; type?: string | null }[]
  genres?: RawGenre[]
  relations?: RawRelation[]
  score?: number
}
type RawReleaseGroup = {
  id: string
  title: string
  'primary-type'?: string | null
  'secondary-types'?: string[]
  'first-release-date'?: string
  disambiguation?: string
  'artist-credit'?: RawCredit[]
  genres?: RawGenre[]
  relations?: RawRelation[]
  score?: number
}
type RawRecording = {
  id: string
  title: string
  length?: number | null
  disambiguation?: string
  video?: boolean
  'artist-credit'?: RawCredit[]
  isrcs?: string[]
  relations?: RawRelation[]
  'first-release-date'?: string
  releases?: RawRelease[]
  score?: number
}
type RawTrack = { id: string; position: number; number: string; title: string; length?: number | null; 'artist-credit'?: RawCredit[]; recording: RawRecording }
type RawMedium = { position?: number; format?: string | null; title?: string; 'track-count': number; tracks?: RawTrack[] }
type RawRelease = {
  id: string
  title: string
  status?: string | null
  date?: string
  country?: string | null
  barcode?: string | null
  disambiguation?: string
  'artist-credit'?: RawCredit[]
  'release-group'?: RawReleaseGroup
  'label-info'?: { 'catalog-number'?: string | null; label?: { id: string; name: string } | null }[]
  media?: RawMedium[]
  'track-count'?: number
  relations?: RawRelation[]
  score?: number
}

const provider = 'musicbrainz'

/**
 * MusicBrainz's special-purpose artists: Various Artists, [anonymous], [no artist],
 * [traditional] and [unknown]. They stand for "no one in particular" on credits, so they
 * have no discography of their own; Various Artists alone is credited on hundreds of
 * thousands of compilations.
 */
export const specialPurposeArtists: ReadonlySet<string> = new Set([
  '89ad4ac3-39f7-470e-963a-56509c546377',
  'f731ccc4-e22a-43af-a747-64213329e088',
  'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',
  '9be7f096-97ec-4615-8957-8d40b5dcbc41',
  '125ec42a-7229-4250-afc5-e057484327fe',
])
const lookupTtl = 7 * 86400
const searchTtl = 86400
const pageSize = 100

/**
 * Whether a host is one of MusicBrainz's own servers (musicbrainz.org, beta., www.), which
 * allow one request per second. An operator's own mirror has no limit.
 */
export function isRateLimitedHost(hostname: string) {
  return hostname === 'musicbrainz.org' || hostname.endsWith('.musicbrainz.org')
}

/** Calls the web service and returns its JSON, or null when disabled or not found. */
async function get<T>(path: string, params: Record<string, string>, ttlSeconds = lookupTtl): Promise<T | null> {
  const settings = await getServerSettings()
  if (!settings.musicBrainzEnabled) return null
  const url = new URL(`ws/2/${path}`, settings.musicBrainzBaseUrl.replace(/\/*$/, '/'))
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  url.searchParams.set('fmt', 'json')
  const limited = isRateLimitedHost(url.hostname)
  const result = await cachedFetch(provider, url.toString(), {
    ttlSeconds,
    headers: { Accept: 'application/json' },
    ...(limited ? { rateLimitKey: provider, rateLimitMs: 1100 } : {}),
  })
  // A lookup answers 400 for a malformed id or ISRC, which is as good as not found.
  if (result.status === 404 || (result.status === 400 && path.includes('/'))) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  return result.json as T
}

/** Quotes a value for a Lucene field query. */
function phrase(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/** Escapes free text so Lucene reads it as plain words. */
function escapeQuery(value: string): string {
  return value.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&')
}

/** The credit as one display string, e.g. "Mark Ronson feat. Bruno Mars". */
export function creditDisplay(credit: MbArtistCredit[]): string {
  return credit.map((part) => part.name + part.joinPhrase).join('').trim()
}

function credits(raw: RawCredit[] | undefined): Pick<MbReleaseGroupSummary, 'artistCredit' | 'artistName'> {
  const artistCredit = (raw ?? []).map((part) => ({ name: part.name, mbid: part.artist.id, joinPhrase: part.joinphrase ?? '' }))
  return { artistCredit, artistName: creditDisplay(artistCredit) }
}

/** Keeps `YYYY`, `YYYY-MM` and `YYYY-MM-DD`; anything else (empty, `????-06`) is null. */
export function normalizeDate(raw: string | null | undefined): MbDate {
  const match = /^(\d{4})(-\d{2}(-\d{2})?)?$/.exec(raw ?? '')
  return match ? { date: match[0], year: Number(match[1]) } : { date: null, year: null }
}

/**
 * Squirmy's album type from MusicBrainz release-group types. Secondary types win over
 * the primary one in the order soundtrack, live, compilation; remix albums and DJ mixes
 * are compilations of other recordings; spoken word, audiobooks and the like are "other".
 * A single, EP or "Other" release stays one whatever its secondary types: a song from a
 * film or a live single is listed with the artist's singles, as stores list it, and a
 * film's soundtrack typed Other (Radiohead's Meeting People Is Easy, a video) is no album
 * of the artist's. Mixtapes keep their
 * primary type, so clients that predate the artist page's Mixtapes section still parse
 * them; the page tells them apart by `secondaryTypes` (catalog/pages.ts).
 */
export function albumType(primary: string | null | undefined, secondary: string[] = []): AlbumType {
  const short = primary?.toLowerCase()
  if (short === 'single' || short === 'ep' || short === 'other') return short
  const types = new Set(secondary.map((type) => type.toLowerCase()))
  if (types.has('soundtrack')) return 'soundtrack'
  if (types.has('live')) return 'live'
  if (types.has('compilation') || types.has('remix') || types.has('dj-mix')) return 'compilation'
  if (['spokenword', 'interview', 'audiobook', 'audio drama'].some((type) => types.has(type))) return 'other'
  switch (primary?.toLowerCase()) {
    case 'album': return 'album'
    case 'ep': return 'ep'
    case 'single': return 'single'
    default: return 'other'
  }
}

function urls(relations: RawRelation[] | undefined): MbUrl[] {
  return (relations ?? []).flatMap((relation) => relation.url ? [{ type: relation.type, url: relation.url.resource }] : [])
}

function genres(raw: RawGenre[] | undefined) {
  return (raw ?? []).map((genre) => ({ name: genre.name, count: genre.count ?? 0 })).sort((a, b) => b.count - a.count)
}

function artistSummary(raw: RawArtist): MbArtistSummary {
  return {
    mbid: raw.id,
    name: raw.name,
    sortName: raw['sort-name'] ?? raw.name,
    disambiguation: raw.disambiguation ?? '',
    type: raw.type ?? null,
    country: raw.country ?? null,
    ...(raw.score === undefined ? {} : { score: raw.score }),
  }
}

function releaseGroupSummary(raw: RawReleaseGroup): MbReleaseGroupSummary {
  return {
    mbid: raw.id,
    title: raw.title,
    type: albumType(raw['primary-type'], raw['secondary-types']),
    primaryType: raw['primary-type'] ?? null,
    secondaryTypes: raw['secondary-types'] ?? [],
    disambiguation: raw.disambiguation ?? '',
    ...credits(raw['artist-credit']),
    ...normalizeDate(raw['first-release-date']),
    ...(raw.score === undefined ? {} : { score: raw.score }),
  }
}

const relationshipRoles: ReadonlyMap<string, CreditRole> = new Map([
  ['composer', 'composer'], ['lyricist', 'lyricist'], ['librettist', 'lyricist'], ['conductor', 'conductor'],
  ['arranger', 'arranger'], ['instrument arranger', 'arranger'], ['orchestrator', 'arranger'], ['vocal arranger', 'arranger'],
  ['producer', 'producer'], ['co-producer', 'producer'], ['executive producer', 'producer'], ['engineer', 'engineer'],
  ['recording', 'engineer'], ['mastering', 'engineer'], ['mix', 'mixer'], ['remixer', 'remixer'],
  ['performer', 'performer'], ['instrument', 'performer'], ['vocal', 'performer'], ['performing orchestra', 'ensemble'],
])

function relationshipCredits(relations: RawRelation[]): MbRelationshipCredit[] {
  return relations.flatMap(({ artist, type, attributes, 'target-credit': creditedName }) => {
    const role = relationshipRoles.get(type)
    if (!artist || !role) return []
    const credit = { role, mbid: artist.id, name: creditedName || artist.name, joinPhrase: '' }
    const instruments = (attributes ?? []).filter((attribute) => !['guest', 'additional', 'solo'].includes(attribute))
    return role === 'performer' && instruments.length ? instruments.map((instrument) => ({ ...credit, instrument })) : [credit]
  })
}

function recordingRelationships(raw: RawRecording) {
  const relationshipCreditsForRecording = relationshipCredits(raw.relations ?? [])
  const works = (raw.relations ?? []).flatMap((relation): MbWork[] => {
    const work = relation.work
    if (!work || relation.type !== 'performance') return []
    const parent = work.relations?.find((part) => part.type === 'parts' && part.direction === 'backward' && part.work)
    relationshipCreditsForRecording.push(...relationshipCredits(work.relations ?? []), ...relationshipCredits(parent?.work?.relations ?? []))
    if (parent?.work) {
      const number = parent['ordering-key']
      return [{
        mbid: parent.work.id, title: parent.work.title, movementName: work.title,
        movementNumber: Number.isInteger(number) && number! > 0 ? number : undefined,
      }]
    }
    return [{ mbid: work.id, title: work.title }]
  })
  return { relationshipCredits: relationshipCreditsForRecording, works }
}

function recordingSummary(raw: RawRecording): MbRecordingSummary {
  return {
    mbid: raw.id,
    title: raw.title,
    durationMs: raw.length ?? null,
    disambiguation: raw.disambiguation ?? '',
    video: raw.video ?? false,
    ...credits(raw['artist-credit']),
    isrcs: raw.isrcs ?? [],
    ...(raw.relations && recordingRelationships(raw)),
  }
}

function recording(raw: RawRecording): MbRecording {
  return {
    ...recordingSummary(raw),
    ...normalizeDate(raw['first-release-date']),
    releases: (raw.releases ?? []).map(releaseSummary),
    ...(raw.score === undefined ? {} : { score: raw.score }),
  }
}

function releaseSummary(raw: RawRelease): MbReleaseSummary {
  const media = (raw.media ?? []).map((medium) => ({ format: medium.format ?? null, trackCount: medium['track-count'] }))
  return {
    mbid: raw.id,
    title: raw.title,
    status: raw.status?.toLowerCase() ?? null,
    country: raw.country ?? null,
    barcode: raw.barcode || null,
    disambiguation: raw.disambiguation ?? '',
    ...credits(raw['artist-credit']),
    ...normalizeDate(raw.date),
    media,
    trackCount: raw['track-count'] ?? media.reduce((sum, medium) => sum + medium.trackCount, 0),
    labels: (raw['label-info'] ?? []).map((info) => ({
      name: info.label?.name ?? null,
      mbid: info.label?.id ?? null,
      catalogNumber: info['catalog-number'] ?? null,
    })),
    releaseGroup: raw['release-group'] ? releaseGroupSummary(raw['release-group']) : null,
    ...(raw.score === undefined ? {} : { score: raw.score }),
  }
}

type SearchPage = { limit?: number; offset?: number }

/** `offset` only past the first page, so the first page's URL (and its cache entry) stays the same. */
const page = ({ limit = 10, offset = 0 }: SearchPage) => ({ limit: String(limit), ...(offset ? { offset: String(offset) } : {}) })

/** Artists by name, best first. Empty when MusicBrainz is off. */
export async function searchArtists(name: string, options: SearchPage = {}): Promise<MbArtistSummary[]> {
  const data = await get<{ artists: RawArtist[] }>('artist', { query: escapeQuery(name), ...page(options) }, searchTtl)
  return (data?.artists ?? []).map(artistSummary)
}

/**
 * Release groups and recordings for free text, best first, as the plain search on
 * musicbrainz.org does it: the text is matched against titles only.
 */
export async function searchReleaseGroupsByText(text: string, options: SearchPage = {}): Promise<MbReleaseGroupSummary[]> {
  const data = await get<{ 'release-groups': RawReleaseGroup[] }>('release-group', { query: escapeQuery(text), ...page(options) }, searchTtl)
  return (data?.['release-groups'] ?? []).map(releaseGroupSummary)
}

/** See `searchReleaseGroupsByText`. Each recording lists the releases it appears on. */
export async function searchRecordingsByText(text: string, options: SearchPage = {}): Promise<MbRecording[]> {
  const data = await get<{ recordings: RawRecording[] }>('recording', { query: escapeQuery(text), ...page(options) }, searchTtl)
  return (data?.recordings ?? []).map(recording)
}

/** Release groups by title, optionally narrowed to an artist, best first. */
export async function searchReleaseGroups(query: { title: string; artist?: string }, options: { limit?: number } = {}): Promise<MbReleaseGroupSummary[]> {
  const terms = [`releasegroup:${phrase(query.title)}`]
  if (query.artist) terms.push(`artist:${phrase(query.artist)}`)
  const data = await get<{ 'release-groups': RawReleaseGroup[] }>('release-group', { query: terms.join(' AND '), limit: String(options.limit ?? 10) }, searchTtl)
  return (data?.['release-groups'] ?? []).map(releaseGroupSummary)
}

/**
 * Releases for album matching. Artist and title must match; track count, barcode and
 * catalog number only raise the score of releases that have them.
 */
export async function searchReleases(query: { artist: string; release: string; tracks?: number; barcode?: string; catno?: string }, options: { limit?: number } = {}): Promise<MbReleaseSummary[]> {
  let lucene = `release:${phrase(query.release)} AND artist:${phrase(query.artist)}`
  if (query.tracks) lucene += ` tracks:${query.tracks}`
  if (query.barcode) lucene += ` barcode:${phrase(query.barcode)}`
  if (query.catno) lucene += ` catno:${phrase(query.catno)}`
  const data = await get<{ releases: RawRelease[] }>('release', { query: lucene, limit: String(options.limit ?? 25) }, searchTtl)
  return (data?.releases ?? []).map(releaseSummary)
}

/** One artist with aliases, genres and external links, or null. */
export async function getArtist(mbid: string): Promise<MbArtist | null> {
  const raw = await get<RawArtist>(`artist/${mbid}`, { inc: 'url-rels genres aliases' })
  if (!raw) return null
  const links = urls(raw.relations)
  const wikidata = links.find((link) => link.type === 'wikidata')?.url.match(/(Q\d+)$/)?.[1]
  return {
    ...artistSummary(raw),
    area: raw.area?.name ?? null,
    lifeSpan: { begin: raw['life-span']?.begin ?? null, end: raw['life-span']?.end ?? null, ended: raw['life-span']?.ended ?? false },
    aliases: (raw.aliases ?? []).map((alias) => ({
      name: alias.name,
      sortName: alias['sort-name'] ?? alias.name,
      locale: alias.locale ?? null,
      primary: alias.primary ?? false,
      type: alias.type ?? null,
    })),
    genres: genres(raw.genres),
    urls: links,
    wikidataId: wikidata ?? null,
  }
}

/** Fetches every page of a browse request, handing each to `onPage` as it arrives. */
async function browseAll<T>(path: string, params: Record<string, string>, listKey: string, countKey: string, onPage?: (batch: T[]) => Promise<void>): Promise<T[] | null> {
  const items: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await get<Record<string, unknown>>(path, { ...params, limit: String(pageSize), offset: String(offset) })
    if (!page) return offset === 0 ? null : items
    const batch = (page[listKey] as T[] | undefined) ?? []
    items.push(...batch)
    if (onPage && batch.length > 0) await onPage(batch)
    if (batch.length < pageSize || items.length >= Number(page[countKey] ?? 0)) return items
  }
}

/**
 * The artist's discography: every release group credited to them, across all pages. With
 * `officialOnly`, only groups with an official release, as the MusicBrainz website lists
 * them by default; bootleg-only groups can outnumber the rest many times over. `onPage`
 * sees each page of 100 as it arrives: a large discography (Bach has thousands of groups
 * at a request a second) is worth writing as it comes in.
 */
export async function browseReleaseGroups(
  artistMbid: string,
  options: { officialOnly?: boolean; onPage?: (groups: MbReleaseGroupSummary[]) => Promise<void> } = {},
): Promise<MbReleaseGroupSummary[]> {
  const params = { artist: artistMbid, inc: 'artist-credits', ...(options.officialOnly ? { 'release-group-status': 'website-default' } : {}) }
  const onPage = options.onPage
  const raw = await browseAll<RawReleaseGroup>('release-group', params, 'release-groups', 'release-group-count',
    onPage ? (batch) => onPage(batch.map(releaseGroupSummary)) : undefined)
  return (raw ?? []).map(releaseGroupSummary)
}

/** One release group with genres, links and all of its releases, or null. */
export async function getReleaseGroup(mbid: string): Promise<MbReleaseGroup | null> {
  const raw = await get<RawReleaseGroup>(`release-group/${mbid}`, { inc: 'artist-credits genres url-rels' })
  if (!raw) return null
  const releases = await browseAll<RawRelease>('release', { 'release-group': mbid, inc: 'media labels' }, 'releases', 'release-count')
  return {
    ...releaseGroupSummary(raw),
    genres: genres(raw.genres),
    urls: urls(raw.relations),
    releases: (releases ?? []).map(releaseSummary),
  }
}

/** One release with its full track list, recordings, ISRCs, labels, release group and links. */
export async function getRelease(mbid: string): Promise<MbRelease | null> {
  const raw = await get<RawRelease>(`release/${mbid}`, { inc: 'artist-credits labels recordings release-groups isrcs url-rels recording-level-rels work-level-rels artist-rels work-rels' })
  if (!raw?.['release-group']) return null
  const { score: _score, ...summary } = releaseSummary(raw)
  return {
    ...summary,
    releaseGroup: releaseGroupSummary(raw['release-group']),
    urls: urls(raw.relations),
    mediums: (raw.media ?? []).map((medium, index) => ({
      position: medium.position ?? index + 1,
      format: medium.format ?? null,
      title: medium.title ?? '',
      tracks: (medium.tracks ?? []).map((track) => ({
        mbid: track.id,
        position: track.position,
        number: track.number,
        title: track.title,
        durationMs: track.length ?? null,
        ...credits(track['artist-credit']),
        recording: recordingSummary({ ...track.recording, relations: track.recording.relations ?? [] }),
      })),
    })),
  }
}

/** One recording with ISRCs and the releases (and release groups) it appears on, or null. */
export async function getRecording(mbid: string): Promise<MbRecording | null> {
  const raw = await get<RawRecording>(`recording/${mbid}`, { inc: 'artist-credits isrcs releases release-groups' })
  return raw ? recording(raw) : null
}

/**
 * What MusicBrainz links to an external URL, e.g. a Deezer artist page to its artist.
 * Null when the URL is unknown.
 */
export async function lookupUrl(resourceUrl: string): Promise<MbUrlLinks | null> {
  const raw = await get<{ resource: string; relations?: RawRelation[] }>('url', {
    resource: resourceUrl,
    inc: 'artist-rels release-rels release-group-rels recording-rels',
  })
  if (!raw) return null
  const links: MbUrlLinks = { url: raw.resource, artists: [], releaseGroups: [], releases: [], recordings: [] }
  for (const relation of raw.relations ?? []) {
    if (relation.artist) links.artists.push({ mbid: relation.artist.id, name: relation.artist.name })
    if (relation['release-group']) links.releaseGroups.push({ mbid: relation['release-group'].id, title: relation['release-group'].title })
    if (relation.release) links.releases.push({ mbid: relation.release.id, title: relation.release.title })
    if (relation.recording) links.recordings.push({ mbid: relation.recording.id, title: relation.recording.title })
  }
  return links
}

/** Releases carrying a barcode (UPC/EAN), each with its release group. */
export async function findReleasesByBarcode(barcode: string): Promise<MbReleaseSummary[]> {
  // A UPC-A and the EAN-13 of the same product differ only by a leading zero.
  const wanted = escapeQuery(barcode.trim().replace(/^0+/, ''))
  const data = await get<{ releases: RawRelease[] }>('release', { query: `barcode:${wanted} OR barcode:0${wanted}`, limit: '25' }, searchTtl)
  return (data?.releases ?? []).filter((release) => release.barcode?.replace(/^0+/, '') === wanted).map(releaseSummary)
}
