import type { RemoteFeedback } from './feedback.js'
import { createHash } from 'node:crypto'
import { cachedFetch, type HttpResult, ProviderError } from '../../lib/http.js'
import { getServerSecret, getServerSettings } from '../../lib/settings.js'

/** One play. `startedAt` is when playback began, as Last.fm's timestamp requires. */
export type LastFmPlay = {
  artist: string
  title: string
  album?: string
  albumArtist?: string
  durationMs?: number
  trackNumber?: number
  /** MusicBrainz recording id. */
  mbid?: string
  startedAt: Date
}

export type LastFmSession = { username: string; sessionKey: string }

export type LastFmScrobbleResult = { accepted: number; ignored: number }

type RawError = { error?: number; message?: string }

const provider = 'lastfm'
const api = 'https://ws.audioscrobbler.com/2.0/'
/** Last.fm accepts at most 50 scrobbles per request. */
const scrobbleBatch = 50
/** Codes Last.fm uses for "try again later": operation failed, service offline, temporarily unavailable, rate limited. */
const retryCodes = new Set([8, 11, 16, 29])
/** Codes for a token the user has not authorized, or that expired; they must start over. */
const badTokenCodes = new Set([4, 14, 15])

/** Error 9: the session key was revoked. The caller should forget it and ask the user to reconnect. */
export const invalidSessionCode = 9

/**
 * The `api_sig` Last.fm requires: every parameter except `format` and `callback`, sorted
 * by name, concatenated as name+value, followed by the secret, MD5 in hex.
 */
export function apiSignature(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((name) => name !== 'format' && name !== 'callback')
    .sort()
    .map((name) => name + params[name])
    .join('')
  return createHash('md5').update(base + secret, 'utf8').digest('hex')
}

async function credentials(): Promise<{ key: string; secret: string } | null> {
  if (!(await getServerSettings()).lastFmKeySet) return null
  const [key, secret] = await Promise.all([getServerSecret('lastFmKey'), getServerSecret('lastFmSecret')])
  return key && secret ? { key, secret } : null
}

/** A signed POST. Last.fm errors arrive as `{ error, message }`, with or without an error status. */
async function call<T>(method: string, params: Record<string, string>, auth: { key: string; secret: string }): Promise<T> {
  const signed = { ...params, method, api_key: auth.key }
  const body = new URLSearchParams({ ...signed, api_sig: apiSignature(signed, auth.secret), format: 'json' }).toString()
  const result = await cachedFetch(provider, api, {
    ttlSeconds: 0,
    cache: 'no-store',
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    rateLimitKey: provider,
    rateLimitMs: 250,
    classify: (response: HttpResult) => retryCodes.has((response.json as RawError | undefined)?.error ?? -1) ? 'retry' : undefined,
  })
  const raw = result.json as (T & RawError) | undefined
  if (raw?.error || result.status !== 200 || !raw) {
    throw new ProviderError(provider, raw?.message ?? `HTTP ${result.status}`, result.status, raw?.error)
  }
  return raw
}

/** Where to send the user to connect their account; Last.fm returns to `callback` with `?token=`. Null without a key. */
export async function getAuthUrl(callback: string): Promise<string | null> {
  const auth = await credentials()
  if (!auth) return null
  return `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: auth.key, cb: callback })}`
}

/**
 * Exchanges the token from the auth callback for a permanent session. Null without a key,
 * or when the token was not authorized or has expired.
 */
export async function getSession(token: string): Promise<LastFmSession | null> {
  const auth = await credentials()
  if (!auth) return null
  try {
    const raw = await call<{ session: { name: string; key: string } }>('auth.getSession', { token }, auth)
    return { username: raw.session.name, sessionKey: raw.session.key }
  } catch (error) {
    if (error instanceof ProviderError && badTokenCodes.has(error.upstreamCode as number)) return null
    throw error
  }
}

function playParams(play: Omit<LastFmPlay, 'startedAt'>, suffix = ''): Record<string, string> {
  const params: Record<string, string> = { [`artist${suffix}`]: play.artist, [`track${suffix}`]: play.title }
  if (play.album) params[`album${suffix}`] = play.album
  if (play.albumArtist) params[`albumArtist${suffix}`] = play.albumArtist
  if (play.durationMs) params[`duration${suffix}`] = String(Math.round(play.durationMs / 1000))
  if (play.trackNumber) params[`trackNumber${suffix}`] = String(play.trackNumber)
  if (play.mbid) params[`mbid${suffix}`] = play.mbid
  return params
}

/**
 * Scrobbles plays in batches of 50. Null without a key. Throws ProviderError on failure;
 * an `upstreamCode` of `invalidSessionCode` means the user must reconnect.
 */
export async function scrobble(sessionKey: string, plays: LastFmPlay[]): Promise<LastFmScrobbleResult | null> {
  const auth = await credentials()
  if (!auth) return null
  const total = { accepted: 0, ignored: 0 }
  for (let start = 0; start < plays.length; start += scrobbleBatch) {
    const params: Record<string, string> = { sk: sessionKey }
    plays.slice(start, start + scrobbleBatch).forEach((play, index) => {
      Object.assign(params, playParams(play, `[${index}]`), { [`timestamp[${index}]`]: String(Math.floor(play.startedAt.getTime() / 1000)) })
    })
    const raw = await call<{ scrobbles: { '@attr': { accepted: number | string; ignored: number | string } } }>('track.scrobble', params, auth)
    total.accepted += Number(raw.scrobbles['@attr'].accepted)
    total.ignored += Number(raw.scrobbles['@attr'].ignored)
  }
  return total
}

/** Tells Last.fm what the user is playing now. False without a key. Throws like `scrobble`. */
export async function updateNowPlaying(sessionKey: string, play: Omit<LastFmPlay, 'startedAt'>): Promise<boolean> {
  const auth = await credentials()
  if (!auth) return false
  await call('track.updateNowPlaying', { sk: sessionKey, ...playParams(play) }, auth)
  return true
}

type RawLovedTrack = { mbid?: string; name?: string; artist?: { name?: string }; date?: { uts?: string } }

export async function lovedPage(account: string, page: number): Promise<{ items: RemoteFeedback[]; more: boolean }> {
  const auth = await credentials()
  if (!auth) return { items: [], more: false }
  const query = new URLSearchParams({ method: 'user.getLovedTracks', user: account, api_key: auth.key, format: 'json', limit: '100', page: String(page) })
  const result = await cachedFetch(provider, `${api}?${query}`, {
    ttlSeconds: 0,
    cache: 'no-store',
    rateLimitKey: provider,
    rateLimitMs: 250,
    classify: response => retryCodes.has((response.json as RawError | undefined)?.error ?? -1) ? 'retry' : undefined,
  })
  const raw = result.json as RawError & { lovedtracks?: { track?: RawLovedTrack[]; '@attr'?: { totalPages?: string } } } | undefined
  if (result.status !== 200 || !Array.isArray(raw?.lovedtracks?.track)) {
    throw new ProviderError(provider, raw?.message ?? `Loved tracks read failed (HTTP ${result.status})`, result.status, raw?.error)
  }
  return {
    items: raw.lovedtracks.track.map(track => ({
      mbid: track.mbid,
      title: track.name,
      artist: track.artist?.name,
      at: Number(track.date?.uts),
      loved: true,
    })),
    more: Number(raw.lovedtracks['@attr']?.totalPages) > page,
  }
}

export async function love(sessionKey: string, artist: string, title: string): Promise<boolean> {
  const auth = await credentials()
  if (!auth) return false
  await call('track.love', { sk: sessionKey, artist, track: title }, auth)
  return true
}
