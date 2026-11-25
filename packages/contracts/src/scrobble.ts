import { z } from 'zod'
import { IsoDateTime } from './common.js'

/** A service plays are scrobbled to. */
export const ScrobbleTarget = z.enum(['listenbrainz', 'lastfm'])
export type ScrobbleTarget = z.infer<typeof ScrobbleTarget>

/** One service as `GET /me/scrobbling` reports it for the signed-in user. */
export const ScrobbleService = z.object({
  target: ScrobbleTarget,
  /** The server can scrobble to it: always for ListenBrainz, for Last.fm once an admin set its API key and secret. */
  available: z.boolean(),
  connected: z.boolean(),
  /** The user's name on the service, while connected. */
  account: z.string().nullable(),
  /** The user's switch for the service: `scrobbleListenBrainz` or `scrobbleLastFm` in `UserSettings`. */
  enabled: z.boolean(),
  /** The service rejected the stored credentials. Deliveries wait until the user connects again. */
  needsAttention: z.boolean(),
  /** The most recent delivery or credential error, cleared by the next success. */
  lastError: z.string().nullable(),
  /** Plays from before this time are never scrobbled. */
  connectedAt: IsoDateTime.nullable(),
  /** Plays waiting to be sent, and plays given up on after repeated failures. */
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})
export type ScrobbleService = z.infer<typeof ScrobbleService>

/** `GET /api/v1/me/scrobbling`, and the answer to every scrobbling mutation. */
export const ScrobblingStatus = z.object({ services: z.array(ScrobbleService) })
export type ScrobblingStatus = z.infer<typeof ScrobblingStatus>

/** `PUT /api/v1/me/scrobbling/listenbrainz`: the user token from the user's ListenBrainz settings page. */
export const ConnectListenBrainzRequest = z.object({ token: z.string().trim().min(1).max(200) })
export type ConnectListenBrainzRequest = z.infer<typeof ConnectListenBrainzRequest>

/**
 * The app schemes a Last.fm approval may return to (`LastFmConnectRequest.returnTo`): the iOS
 * app's, and its development build's. Anything else returns to the web app.
 */
export const lastFmReturnSchemes = ['squirmy', 'squirmy-dev'] as const

/**
 * `POST /api/v1/me/scrobbling/lastfm/start`, optionally with where the browser goes once Last.fm
 * answers: a URL in one of `lastFmReturnSchemes`, such as `squirmy://settings`, for an app that
 * opened the approval in its own browser session. Without one, it goes to the web app.
 */
export const LastFmConnectRequest = z.object({
  returnTo: z.string().max(200).refine(isLastFmReturn, 'Not a return address this server allows').optional(),
})
export type LastFmConnectRequest = z.infer<typeof LastFmConnectRequest>

/** Whether `url` is a return address `LastFmConnectRequest` allows: one of the app schemes, no spaces. */
export function isLastFmReturn(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/\S*$/i.exec(url)?.[1]
  return Boolean(scheme && (lastFmReturnSchemes as readonly string[]).includes(scheme))
}

/**
 * The answer to `POST /api/v1/me/scrobbling/lastfm/start`: open `url` in a browser. After the user
 * approves, Last.fm returns to the server, which stores the session and redirects to the web
 * app's `/settings?lastfm=connected`, or to `returnTo` with the same `lastfm` parameter.
 * Otherwise `lastfm` is `denied` (not approved), `invalid_state` (forged or older than ten
 * minutes: start again) or `error` (Last.fm failed).
 */
export const LastFmConnectStart = z.object({ url: z.url() })
export type LastFmConnectStart = z.infer<typeof LastFmConnectStart>

/** What `lastfm` says on the page Last.fm's approval returns to. */
export const LastFmOutcome = z.enum(['connected', 'denied', 'invalid_state', 'error'])
export type LastFmOutcome = z.infer<typeof LastFmOutcome>
