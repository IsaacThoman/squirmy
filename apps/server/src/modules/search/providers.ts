/**
 * Catalog search providers. Each answers one query with artists, albums and tracks in a
 * shared normalized shape, carrying its own ids. `searchCatalog` picks one per request:
 * the local index when it is ready, Deezer when it is enabled, MusicBrainz otherwise, and
 * falls through to the next when one fails.
 */
import type { AlbumType } from '@squirmy/contracts'
import { getSql } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { matchKey } from '../../lib/text.js'
import { isCatalogIndexReady, searchCatalogIndex, type CatalogIndexResult } from '../catalog-index/search.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import type { DeezerAlbumSummary, DeezerTrack } from '../metadata/deezer.js'
import type { MbArtistCredit, MbRecording, MbReleaseGroupSummary } from '../metadata/musicbrainz.js'
import { editionFreeQuery } from './keys.js'

/** Whose ids a result carries; also the `external_ids.provider` they are stored under. */
export type IdSource = 'deezer' | 'musicbrainz'

/** An artist as credited on an album or track. `id` is null when the provider gives none. */
export type ProviderCredit = { id: string | null; mbid: string | null; name: string; joinPhrase: string }

export type ProviderArtist = { id: string; mbid: string | null; name: string; imageUrl: string | null }

/** `id` is null for an album known only by name (the local index's album of a recording). */
export type ProviderAlbum = {
  id: string | null
  /** Release group MBID. */
  mbid: string | null
  title: string
  artistCredit: string
  artists: ProviderCredit[]
  /** Null when the provider names no type: an album known only as a track's album. */
  type: AlbumType | null
  year: number | null
  releaseDate: string | null
  artworkUrl: string | null
}

export type ProviderTrack = {
  id: string
  mbid: string | null
  title: string
  artistCredit: string
  artists: ProviderCredit[]
  durationMs: number | null
  explicit: boolean | null
  /** 0..1, when the provider measures it. */
  popularity: number | null
  isrcs: string[]
  /** An album the track appears on. */
  album: ProviderAlbum | null
}

export type ProviderResults = { artists: ProviderArtist[]; albums: ProviderAlbum[]; tracks: ProviderTrack[] }

export type SearchProvider = {
  /** Reported in `SearchResults.provider`. */
  name: 'local-index' | 'deezer' | 'musicbrainz'
  idSource: IdSource
  /** Whether the provider may be asked right now. */
  available: () => Promise<boolean>
  /** At most `limit` results of each kind, best first. Throws when the service fails. */
  search: (query: string, options: { limit: number }) => Promise<ProviderResults>
}

/** Cover Art Archive's front cover of a release group, fetched only when a client shows it. */
async function releaseGroupCover(mbid: string | null): Promise<string | null> {
  if (!mbid || !(await getServerSettings()).coverArtArchiveEnabled) return null
  return `https://coverartarchive.org/release-group/${mbid}/front-500`
}

// ---------------------------------------------------------------------------
// Deezer
// ---------------------------------------------------------------------------

/** Deezer's track rank reaches about a million for the most played songs. */
const deezerTopRank = 1_000_000

function deezerCredit(artist: { id: number; name: string }): ProviderCredit {
  return { id: String(artist.id), mbid: null, name: artist.name, joinPhrase: '' }
}

function deezerAlbum(album: DeezerAlbumSummary): ProviderAlbum {
  return {
    id: String(album.id),
    mbid: null,
    title: album.title,
    artistCredit: album.artist.name,
    artists: [deezerCredit(album.artist)],
    type: album.type,
    year: album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : null,
    releaseDate: album.releaseDate,
    artworkUrl: album.coverUrl,
  }
}

function deezerTrack(track: DeezerTrack): ProviderTrack {
  const artists = track.artists.map((artist, index) => ({ ...deezerCredit(artist), joinPhrase: index < track.artists.length - 1 ? ', ' : '' }))
  return {
    id: String(track.id),
    mbid: null,
    title: track.title,
    artistCredit: artists.map((artist) => artist.name + artist.joinPhrase).join(''),
    artists,
    durationMs: track.durationMs || null,
    explicit: track.explicit,
    popularity: track.rank === null ? null : Math.min(1, track.rank / deezerTopRank),
    isrcs: track.isrc ? [track.isrc] : [],
    // Deezer names the album but not its artist or type; the track's artist stands in. The
    // type stays unknown: calling it an album filed singles under Albums (materialize.ts).
    album: track.album && {
      id: String(track.album.id),
      mbid: null,
      title: track.album.title,
      artistCredit: track.artist.name,
      artists: [deezerCredit(track.artist)],
      type: null,
      year: null,
      releaseDate: null,
      artworkUrl: track.album.coverUrl,
    },
  }
}

export const deezerProvider: SearchProvider = {
  name: 'deezer',
  idSource: 'deezer',
  available: async () => (await getServerSettings()).deezerEnabled,
  async search(query, { limit }) {
    const results = await deezer.search(query, { limit })
    return {
      artists: results.artists.map((artist) => ({ id: String(artist.id), mbid: null, name: artist.name, imageUrl: artist.imageUrl })),
      albums: results.albums.map(deezerAlbum),
      tracks: results.tracks.map(deezerTrack),
    }
  },
}

// ---------------------------------------------------------------------------
// MusicBrainz
// ---------------------------------------------------------------------------

function mbCredits(credits: MbArtistCredit[]): ProviderCredit[] {
  return credits.map((credit) => ({ id: credit.mbid, mbid: credit.mbid, name: credit.name, joinPhrase: credit.joinPhrase }))
}

async function mbAlbum(group: MbReleaseGroupSummary, credits = group.artistCredit): Promise<ProviderAlbum> {
  return {
    id: group.mbid,
    mbid: group.mbid,
    title: group.title,
    artistCredit: musicbrainz.creditDisplay(credits),
    artists: mbCredits(credits),
    type: group.type,
    year: group.year,
    releaseDate: group.date,
    artworkUrl: await releaseGroupCover(group.mbid),
  }
}

async function mbTrack(recording: MbRecording): Promise<ProviderTrack> {
  // The first release on an album, else the first release, stands for the track's album.
  const release = recording.releases.find((one) => one.releaseGroup?.type === 'album') ?? recording.releases.find((one) => one.releaseGroup)
  return {
    id: recording.mbid,
    mbid: recording.mbid,
    title: recording.title,
    artistCredit: recording.artistName,
    artists: mbCredits(recording.artistCredit),
    durationMs: recording.durationMs,
    explicit: null,
    popularity: null,
    isrcs: recording.isrcs,
    album: release ? await mbAlbum(release.releaseGroup!, release.artistCredit.length > 0 ? release.artistCredit : recording.artistCredit) : null,
  }
}

export const musicBrainzProvider: SearchProvider = {
  name: 'musicbrainz',
  idSource: 'musicbrainz',
  available: async () => (await getServerSettings()).musicBrainzEnabled,
  async search(query, { limit }) {
    // Sequential: the client spaces requests a second apart anyway.
    const artists = await musicbrainz.searchArtists(query, { limit })
    const groups = await musicbrainz.searchReleaseGroupsByText(query, { limit })
    const recordings = await musicbrainz.searchRecordingsByText(query, { limit })
    return {
      artists: artists.map((artist) => ({ id: artist.mbid, mbid: artist.mbid, name: artist.name, imageUrl: null })),
      albums: await Promise.all(groups.map((group) => mbAlbum(group))),
      tracks: await Promise.all(recordings.filter((recording) => !recording.video).map(mbTrack)),
    }
  },
}

// ---------------------------------------------------------------------------
// Local search index
// ---------------------------------------------------------------------------

/**
 * MBIDs of the index's artists and albums with these exact names, most popular first.
 * The index names a credit and a recording's album only as text.
 */
async function indexMbids(kind: 'artist' | 'album', keys: string[]) {
  if (keys.length === 0) return []
  return getSql()<{ nameKey: string; artistName: string | null; mbid: string }[]>`
    select name_key as "nameKey", artist_name as "artistName", mbid from catalog_index
    where kind = ${kind} and name_key collate "C" = any(${keys}::text[])
    order by score desc`
}

export const localIndexProvider: SearchProvider = {
  name: 'local-index',
  idSource: 'musicbrainz',
  available: isCatalogIndexReady,
  async search(query, { limit }) {
    const results = await searchCatalogIndex(query, { limit })
    const of = (kind: CatalogIndexResult['kind']) => results.filter((result) => result.kind === kind)
    const credited = results.flatMap((result) => (result.artistName ? [matchKey(result.artistName)] : []))
    const albumNames = of('recording').flatMap((result) => (result.albumName ? [matchKey(result.albumName)] : []))
    const [artistRows, albumRows] = await Promise.all([indexMbids('artist', [...new Set(credited)]), indexMbids('album', [...new Set(albumNames)])])
    const artistMbid = new Map<string, string>()
    for (const row of artistRows) if (!artistMbid.has(row.nameKey)) artistMbid.set(row.nameKey, row.mbid)

    const credit = (name: string): ProviderCredit[] => {
      const mbid = artistMbid.get(matchKey(name)) ?? null
      return [{ id: mbid, mbid, name, joinPhrase: '' }]
    }
    const album = async (mbid: string | null, title: string, artistName: string): Promise<ProviderAlbum> => ({
      id: mbid,
      mbid,
      title,
      artistCredit: artistName,
      artists: credit(artistName),
      // The index does not record album types.
      type: null,
      year: null,
      releaseDate: null,
      artworkUrl: await releaseGroupCover(mbid),
    })
    const albumOf = (title: string, artistName: string) =>
      albumRows.find((row) => row.nameKey === matchKey(title) && matchKey(row.artistName ?? '') === matchKey(artistName))?.mbid ?? null

    return {
      artists: of('artist').map((artist) => ({ id: artist.mbid, mbid: artist.mbid, name: artist.name, imageUrl: null })),
      albums: await Promise.all(of('album').map((result) => album(result.mbid, result.name, result.artistName ?? ''))),
      tracks: await Promise.all(of('recording').map(async (result): Promise<ProviderTrack> => {
        const artistName = result.artistName ?? ''
        return {
          id: result.mbid,
          mbid: result.mbid,
          title: result.name,
          artistCredit: artistName,
          artists: credit(artistName),
          durationMs: null,
          explicit: null,
          popularity: null,
          isrcs: [],
          album: result.albumName ? await album(albumOf(result.albumName, artistName), result.albumName, artistName) : null,
        }
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

export const searchProviders: readonly SearchProvider[] = [localIndexProvider, deezerProvider, musicBrainzProvider]

/** `first`'s results, then those of `second` it lacks, at most `limit` of each kind. */
function mergeResults(first: ProviderResults, second: ProviderResults, limit: number): ProviderResults {
  const merge = <T>(a: T[], b: T[], key: (item: T) => string) => {
    const seen = new Set(a.map(key))
    return [...a, ...b.filter((item) => !seen.has(key(item)))].slice(0, limit)
  }
  return {
    artists: merge(first.artists, second.artists, (artist) => artist.id),
    albums: merge(first.albums, second.albums, (album) => album.id ?? `${matchKey(album.artistCredit)}|${matchKey(album.title)}`),
    tracks: merge(first.tracks, second.tracks, (track) => track.id),
  }
}

/** Provider calls in progress, so identical queries arriving together share one. */
const inFlight = new Map<string, Promise<ProviderResults>>()

function shared(provider: SearchProvider, query: string, limit: number): Promise<ProviderResults> {
  const key = `${provider.name}\n${limit}\n${query}`
  let call = inFlight.get(key)
  if (!call) {
    call = provider.search(query, { limit }).finally(() => inFlight.delete(key))
    inFlight.set(key, call)
  }
  return call
}

/**
 * Asks the first available provider in `providers` order and returns its results, falling
 * through to the next one when it throws. `provider` is null when none is available; when
 * every available provider fails, the last error is thrown.
 */
export async function searchCatalog(query: string, limit: number, providers: readonly SearchProvider[] = searchProviders):
  Promise<{ provider: SearchProvider | null; results: ProviderResults }> {
  // Providers ignore case and spacing, so variants share a call and a cache entry.
  const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase()
  const key = matchKey(normalized)
  const plainKey = editionFreeQuery(key)
  const plain = plainKey === key ? normalized : plainKey
  let failure: unknown
  for (const provider of providers) {
    if (!(await provider.available())) continue
    try {
      if (plain === normalized) return { provider, results: await shared(provider, normalized, limit) }
      const [whole, withoutEdition] = await Promise.all([shared(provider, normalized, limit), shared(provider, plain, limit)])
      return { provider, results: mergeResults(whole, withoutEdition, limit) }
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw failure
  return { provider: null, results: { artists: [], albums: [], tracks: [] } }
}
