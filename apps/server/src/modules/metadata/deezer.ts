import type { AlbumType } from '@squirmy/contracts'
import { cachedFetch, type HttpResult, ProviderError, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** A Deezer artist. Image URLs are the 1000 px ("xl") rendition, null for Deezer's blank placeholder. */
export type DeezerArtist = {
  id: number
  name: string
  imageUrl: string | null
  /** The deezer.com page; MusicBrainz url relations use this form. */
  link: string
  fans: number | null
  albumCount: number | null
}

export type DeezerAlbumSummary = {
  id: number
  title: string
  artist: { id: number; name: string }
  coverUrl: string | null
  type: AlbumType
  explicit: boolean
  /** YYYY-MM-DD, when Deezer gives one. */
  releaseDate: string | null
  trackCount: number | null
  link: string
}

export type DeezerTrack = {
  id: number
  title: string
  durationMs: number
  explicit: boolean
  /** Deezer's popularity score; higher is more played. */
  rank: number | null
  isrc: string | null
  artist: { id: number; name: string }
  /** Every credited artist (main and featured), when Deezer lists them; else just `artist`. */
  artists: { id: number; name: string }[]
  album: { id: number; title: string; coverUrl: string | null } | null
  discNumber: number | null
  trackNumber: number | null
  link: string
}

export type DeezerAlbum = DeezerAlbumSummary & {
  upc: string | null
  label: string | null
  genres: string[]
  /** In disc and track order, with ISRCs. */
  tracks: DeezerTrack[]
}

export type DeezerSearchType = 'artist' | 'album' | 'track'
export type DeezerSearchResults = { artists: DeezerArtist[]; albums: DeezerAlbumSummary[]; tracks: DeezerTrack[] }

type RawArtist = { id: number; name: string; link?: string; picture_xl?: string; nb_fan?: number; nb_album?: number }
type RawAlbum = {
  id: number
  title: string
  link?: string
  cover_xl?: string
  record_type?: string
  explicit_lyrics?: boolean
  release_date?: string
  nb_tracks?: number
  upc?: string
  label?: string
  genres?: { data: { name: string }[] }
  artist?: RawArtist
}
type RawTrack = {
  id: number
  title: string
  link?: string
  duration: number
  explicit_lyrics?: boolean
  rank?: number
  isrc?: string
  track_position?: number
  disk_number?: number
  artist: RawArtist
  contributors?: RawArtist[]
  album?: RawAlbum
}
type RawList<T> = { data: T[]; next?: string; total?: number }
type RawError = { error?: { type?: string; message?: string; code?: number } }

const provider = 'deezer'
const ttl = 86400
/** Deezer's documented quota error code; "no data" is 800. */
const quotaCode = 4
const notFoundCode = 800

/** Deezer reports errors in 200 bodies: quota errors retry, "no data" is a miss. */
function classify(result: HttpResult) {
  const code = (result.json as RawError | undefined)?.error?.code
  if (code === quotaCode) return 'retry'
  if (code === notFoundCode) return 'miss'
  return undefined
}

/** GETs an API path; null when Deezer is off or has no such object. */
async function get<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const settings = await getServerSettings()
  if (!settings.deezerEnabled) return null
  const url = new URL(path, 'https://api.deezer.com/')
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return getUrl<T>(url.toString())
}

async function getUrl<T>(url: string): Promise<T | null> {
  // 50 requests per 5 seconds, spread evenly.
  const result = await cachedFetch(provider, url, { ttlSeconds: ttl, rateLimitKey: provider, rateLimitMs: 100, classify })
  if (result.status === 404) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  const error = (result.json as RawError).error
  if (error?.code === notFoundCode) return null
  if (error) throw new ProviderError(provider, error.message ?? 'unknown error', result.status, error.code)
  return result.json as T
}

/** Fetches every page of a list, following `next`. */
async function getAll<T>(path: string, params: Record<string, string> = {}): Promise<T[] | null> {
  const first = await get<RawList<T>>(path, { ...params, limit: '100' })
  if (!first) return null
  const items = [...first.data]
  let next = first.next
  while (next) {
    const page = await getUrl<RawList<T>>(next)
    if (!page) break
    items.push(...page.data)
    next = page.next
  }
  return items
}

/** Deezer serves a blank placeholder (empty hash in the path) for missing images. */
function image(url: string | undefined): string | null {
  return url && !/\/images\/(artist|cover)\/\//.test(url) ? url : null
}

function albumType(recordType: string | undefined): AlbumType {
  switch (recordType) {
    case 'album': return 'album'
    case 'ep': return 'ep'
    case 'single': return 'single'
    case 'compile': return 'compilation'
    default: return 'other'
  }
}

function artist(raw: RawArtist): DeezerArtist {
  return {
    id: raw.id,
    name: raw.name,
    imageUrl: image(raw.picture_xl),
    link: raw.link ?? `https://www.deezer.com/artist/${raw.id}`,
    fans: raw.nb_fan ?? null,
    albumCount: raw.nb_album ?? null,
  }
}

function albumSummary(raw: RawAlbum, fallbackArtist?: RawArtist): DeezerAlbumSummary {
  const owner = raw.artist ?? fallbackArtist
  return {
    id: raw.id,
    title: raw.title,
    artist: { id: owner?.id ?? 0, name: owner?.name ?? '' },
    coverUrl: image(raw.cover_xl),
    type: albumType(raw.record_type),
    explicit: raw.explicit_lyrics ?? false,
    releaseDate: raw.release_date && raw.release_date !== '0000-00-00' ? raw.release_date : null,
    trackCount: raw.nb_tracks ?? null,
    link: raw.link ?? `https://www.deezer.com/album/${raw.id}`,
  }
}

/** Contributors repeat an artist once per role (Main, Featured); keep the first. */
function credited(raw: RawTrack): { id: number; name: string }[] {
  const seen = new Map<number, string>()
  for (const one of raw.contributors?.length ? raw.contributors : [raw.artist]) {
    if (!seen.has(one.id)) seen.set(one.id, one.name)
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

function track(raw: RawTrack, album?: RawAlbum): DeezerTrack {
  const owner = raw.album ?? album
  return {
    id: raw.id,
    title: raw.title,
    durationMs: raw.duration * 1000,
    explicit: raw.explicit_lyrics ?? false,
    rank: raw.rank ?? null,
    isrc: raw.isrc ?? null,
    artist: { id: raw.artist.id, name: raw.artist.name },
    artists: credited(raw),
    album: owner ? { id: owner.id, title: owner.title, coverUrl: image(owner.cover_xl) } : null,
    discNumber: raw.disk_number ?? null,
    trackNumber: raw.track_position ?? null,
    link: raw.link ?? `https://www.deezer.com/track/${raw.id}`,
  }
}

/**
 * Catalog search for typeahead: the requested types are fetched in parallel, each
 * ranked by Deezer. Empty lists when Deezer is off.
 */
export async function search(query: string, options: { types?: DeezerSearchType[]; limit?: number } = {}): Promise<DeezerSearchResults> {
  const types = options.types ?? ['artist', 'album', 'track']
  const params = { q: query, limit: String(options.limit ?? 10) }
  const [artists, albums, tracks] = await Promise.all([
    types.includes('artist') ? get<RawList<RawArtist>>('search/artist', params) : null,
    types.includes('album') ? get<RawList<RawAlbum>>('search/album', params) : null,
    types.includes('track') ? get<RawList<RawTrack>>('search/track', params) : null,
  ])
  return {
    artists: (artists?.data ?? []).map(artist),
    albums: (albums?.data ?? []).map((raw) => albumSummary(raw)),
    tracks: (tracks?.data ?? []).map((raw) => track(raw)),
  }
}

/** An album with UPC, label, genres and its full track list (with disc numbers and ISRCs). */
export async function getAlbum(id: number): Promise<DeezerAlbum | null> {
  const [raw, tracks] = await Promise.all([get<RawAlbum>(`album/${id}`), getAll<RawTrack>(`album/${id}/tracks`)])
  if (!raw) return null
  return {
    ...albumSummary(raw),
    upc: raw.upc ?? null,
    label: raw.label ?? null,
    genres: (raw.genres?.data ?? []).map((genre) => genre.name),
    tracks: (tracks ?? []).map((one) => track(one, raw)),
  }
}

/** The album with this UPC (barcode), with its track list as `getAlbum` returns it. */
export async function getAlbumByUpc(upc: string): Promise<DeezerAlbum | null> {
  const raw = await get<RawAlbum>(`album/upc:${encodeURIComponent(upc.trim())}`)
  return raw ? getAlbum(raw.id) : null
}

/** The track with this ISRC, with its album and every contributing artist. */
export async function getTrackByIsrc(isrc: string): Promise<DeezerTrack | null> {
  const raw = await get<RawTrack>(`track/isrc:${encodeURIComponent(isrc.trim().toUpperCase())}`)
  return raw ? track(raw) : null
}

export async function getArtist(id: number): Promise<DeezerArtist | null> {
  const raw = await get<RawArtist>(`artist/${id}`)
  return raw ? artist(raw) : null
}

/** The artist's most played tracks, most popular first. */
export async function getArtistTopTracks(id: number, options: { limit?: number } = {}): Promise<DeezerTrack[]> {
  const raw = await get<RawList<RawTrack>>(`artist/${id}/top`, { limit: String(options.limit ?? 10) })
  return (raw?.data ?? []).map((one) => track(one))
}

/** Artists Deezer considers similar, most similar first. */
export async function getRelatedArtists(id: number, options: { limit?: number } = {}): Promise<DeezerArtist[]> {
  const raw = await get<RawList<RawArtist>>(`artist/${id}/related`, { limit: String(options.limit ?? 20) })
  return (raw?.data ?? []).map(artist)
}

/** Every album, EP, single and compilation Deezer lists for the artist, across all pages. */
export async function getArtistAlbums(id: number): Promise<DeezerAlbumSummary[]> {
  // The album list leaves out the artist, so it is fetched alongside.
  const [owner, raw] = await Promise.all([get<RawArtist>(`artist/${id}`), getAll<RawAlbum>(`artist/${id}/albums`)])
  return (raw ?? []).map((one) => albumSummary(one, owner ?? { id, name: '' }))
}
