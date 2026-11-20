import { cachedFetch, unexpectedResponse } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'

/** Lyrics for one track. `synced` is LRC text (`[mm:ss.xx]line`); an instrumental has neither. */
export type Lyrics = { synced: string | null; plain: string | null; instrumental: boolean }

export type LyricsQuery = { title: string; artist: string; album?: string; durationMs: number }

type RawLyrics = { duration: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null }

const provider = 'lrclib'
const ttl = 30 * 86400
/** LRCLIB matches durations within two seconds. */
const toleranceSec = 2

async function get<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(path, 'https://lrclib.net/')
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const result = await cachedFetch(provider, url.toString(), { ttlSeconds: ttl, headers: { Accept: 'application/json' } })
  if (result.status === 404) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  return result.json as T
}

function lyrics(raw: RawLyrics): Lyrics {
  return { synced: raw.syncedLyrics || null, plain: raw.plainLyrics || null, instrumental: raw.instrumental }
}

/**
 * Lyrics for a track: LRCLIB's exact match on title, artist, album and duration first,
 * then a search on title and artist, keeping results within two seconds of the duration
 * and preferring synced lyrics. Null when nothing matches or LRCLIB is off.
 */
export async function getLyrics(query: LyricsQuery): Promise<Lyrics | null> {
  if (!(await getServerSettings()).lrclibEnabled) return null
  const durationSec = Math.round(query.durationMs / 1000)
  const exact = await get<RawLyrics>('api/get', {
    track_name: query.title,
    artist_name: query.artist,
    ...(query.album ? { album_name: query.album } : {}),
    duration: String(durationSec),
  })
  if (exact) return lyrics(exact)

  const results = await get<RawLyrics[]>('api/search', { track_name: query.title, artist_name: query.artist })
  const close = (results ?? []).filter((one) => Math.abs(one.duration - query.durationMs / 1000) <= toleranceSec)
  const best = close.find((one) => one.syncedLyrics) ?? close.find((one) => one.plainLyrics) ?? close.find((one) => one.instrumental)
  return best ? lyrics(best) : null
}
