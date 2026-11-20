import { cachedFetch, ProviderError, unexpectedResponse } from '../../lib/http.js'
import { getServerSecret, getServerSettings } from '../../lib/settings.js'

/** A recording ranked by how often ListenBrainz users play it. */
export type LbTopRecording = {
  recordingMbid: string
  title: string
  artistName: string
  artistMbids: string[]
  releaseMbid: string | null
  releaseName: string | null
  durationMs: number | null
  listenCount: number
  userCount: number
}

/** Play counts for one recording; null counts mean ListenBrainz has no data for it. */
export type LbPopularity = { recordingMbid: string; listenCount: number | null; userCount: number | null }

export type LbSimilarArtist = { mbid: string; name: string; comment: string; type: string | null; score: number }

/** One play to submit. Omit `listenedAt` for `playing_now`. */
export type LbListen = {
  listenedAt?: Date
  artist: string
  title: string
  album?: string
  recordingMbid?: string
  releaseMbid?: string
  releaseGroupMbid?: string
  artistMbids?: string[]
  durationMs?: number
  trackNumber?: number
  isrc?: string
}

/** `single` for one finished play, `playing_now` for the current track, `import` for a backlog. */
export type LbListenType = 'single' | 'playing_now' | 'import'

type RawTopRecording = {
  recording_mbid: string
  recording_name: string
  artist_name: string
  artist_mbids?: string[]
  release_mbid?: string | null
  release_name?: string | null
  length?: number | null
  total_listen_count: number
  total_user_count: number
}

const provider = 'listenbrainz'
const api = 'https://api.listenbrainz.org/1/'
const ttl = 7 * 86400
const rateLimit = { rateLimitKey: provider, rateLimitMs: 350 }
/** The algorithm ListenBrainz's own artist pages use. */
const similarArtistsAlgorithm = 'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30'
/** ListenBrainz's MAX_ITEMS_PER_GET and MAX_LISTENS_PER_REQUEST. */
const popularityBatch = 100
const importBatch = 1000

/**
 * The read endpoints are public, but ListenBrainz is "on once a token is set" so the
 * operator controls it; the token is sent too, as some endpoints now require one.
 */
async function serverToken(): Promise<string | null> {
  if (!(await getServerSettings()).listenBrainzTokenSet) return null
  return getServerSecret('listenBrainzToken')
}

async function read<T>(url: string, token: string, init: { method?: 'POST'; body?: string } = {}): Promise<T | null> {
  const result = await cachedFetch(provider, url, {
    ttlSeconds: ttl,
    headers: { Accept: 'application/json', Authorization: `Token ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    ...init,
    ...rateLimit,
  })
  if (result.status === 404 || result.status === 400) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  return result.json as T
}

/** The artist's most-listened recordings, most popular first. Empty without a server token. */
export async function topRecordingsForArtist(artistMbid: string, options: { limit?: number } = {}): Promise<LbTopRecording[]> {
  const token = await serverToken()
  if (!token) return []
  const raw = await read<RawTopRecording[]>(`${api}popularity/top-recordings-for-artist/${artistMbid}`, token)
  return (raw ?? []).slice(0, options.limit ?? 25).map((one) => ({
    recordingMbid: one.recording_mbid,
    title: one.recording_name,
    artistName: one.artist_name,
    artistMbids: one.artist_mbids ?? [],
    releaseMbid: one.release_mbid ?? null,
    releaseName: one.release_name ?? null,
    durationMs: one.length ?? null,
    listenCount: one.total_listen_count,
    userCount: one.total_user_count,
  }))
}

/** Listen and listener counts for recordings, in the order given. Empty without a server token. */
export async function recordingPopularity(recordingMbids: string[]): Promise<LbPopularity[]> {
  const token = await serverToken()
  if (!token || recordingMbids.length === 0) return []
  const results: LbPopularity[] = []
  for (let start = 0; start < recordingMbids.length; start += popularityBatch) {
    const batch = recordingMbids.slice(start, start + popularityBatch)
    const raw = await read<{ recording_mbid: string; total_listen_count: number | null; total_user_count: number | null }[]>(
      `${api}popularity/recording`, token, { method: 'POST', body: JSON.stringify({ recording_mbids: batch }) },
    )
    const counts = new Map((raw ?? []).map((one) => [one.recording_mbid, one]))
    results.push(...batch.map((mbid) => ({
      recordingMbid: mbid,
      listenCount: counts.get(mbid)?.total_listen_count ?? null,
      userCount: counts.get(mbid)?.total_user_count ?? null,
    })))
  }
  return results
}

/**
 * Artists listened to in the same sessions, most similar first, from the ListenBrainz
 * Labs dataset. Empty without a server token.
 */
export async function similarArtists(artistMbid: string, options: { limit?: number } = {}): Promise<LbSimilarArtist[]> {
  const token = await serverToken()
  if (!token) return []
  const url = `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${artistMbid}&algorithm=${similarArtistsAlgorithm}`
  const raw = await read<{ artist_mbid: string; name: string; comment?: string; type?: string | null; score: number }[]>(url, token)
  return (raw ?? [])
    .filter((one) => one.artist_mbid !== artistMbid)
    .slice(0, options.limit ?? 25)
    .map((one) => ({ mbid: one.artist_mbid, name: one.name, comment: one.comment ?? '', type: one.type ?? null, score: one.score }))
}

/**
 * Checks a user's token with ListenBrainz. Returns the account it belongs to, or null
 * when ListenBrainz does not accept it. Works without a server token: scrobbling only
 * needs the user's own.
 */
export async function validateToken(userToken: string): Promise<{ userName: string } | null> {
  // The token travels in a header, which is not part of the cache key, so nothing is cached.
  const result = await cachedFetch(provider, `${api}validate-token`, {
    ttlSeconds: 0,
    cache: 'no-store',
    headers: { Accept: 'application/json', Authorization: `Token ${userToken}` },
    ...rateLimit,
  })
  if (result.status === 400 || result.status === 401) return null
  if (result.status !== 200) throw unexpectedResponse(provider, result)
  const body = result.json as { valid?: boolean; user_name?: string } | undefined
  return body?.valid && body.user_name ? { userName: body.user_name } : null
}

function payload(listen: LbListen, type: LbListenType) {
  const info: Record<string, unknown> = { submission_client: 'Squirmy', media_player: 'Squirmy' }
  if (listen.recordingMbid) info.recording_mbid = listen.recordingMbid
  if (listen.releaseMbid) info.release_mbid = listen.releaseMbid
  if (listen.releaseGroupMbid) info.release_group_mbid = listen.releaseGroupMbid
  if (listen.artistMbids?.length) info.artist_mbids = listen.artistMbids
  if (listen.durationMs) info.duration_ms = listen.durationMs
  if (listen.trackNumber) info.tracknumber = listen.trackNumber
  if (listen.isrc) info.isrc = listen.isrc
  return {
    ...(type !== 'playing_now' && listen.listenedAt ? { listened_at: Math.floor(listen.listenedAt.getTime() / 1000) } : {}),
    track_metadata: {
      artist_name: listen.artist,
      track_name: listen.title,
      ...(listen.album ? { release_name: listen.album } : {}),
      additional_info: info,
    },
  }
}

/**
 * Submits plays with a user's own token. `single` and `playing_now` take exactly one
 * listen; `import` is sent in batches of 1000. Throws ProviderError on rejection; an
 * `upstreamStatus` of 401 means the user's token is no longer valid.
 */
export async function submitListens(userToken: string, listens: LbListen[], type: LbListenType): Promise<void> {
  if (type !== 'import' && listens.length !== 1) throw new Error(`A ${type} submission takes exactly one listen`)
  for (let start = 0; start < listens.length; start += importBatch) {
    const body = JSON.stringify({ listen_type: type, payload: listens.slice(start, start + importBatch).map((listen) => payload(listen, type)) })
    const result = await cachedFetch(provider, `${api}submit-listens`, {
      ttlSeconds: 0,
      cache: 'no-store',
      method: 'POST',
      body,
      headers: { Authorization: `Token ${userToken}`, 'Content-Type': 'application/json' },
      ...rateLimit,
    })
    if (result.status !== 200) {
      const message = (result.json as { error?: string } | undefined)?.error ?? `HTTP ${result.status}`
      throw new ProviderError(provider, message, result.status)
    }
  }
}
