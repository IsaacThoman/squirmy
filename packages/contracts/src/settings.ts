import { z } from 'zod'
import { Id } from './common.js'
import { NormalizationMode, StreamQuality } from './playback.js'

/** Per-user preferences, stored on the user row. */
export const UserSettings = z.object({
  normalization: NormalizationMode.default('auto'),
  qualityWifi: StreamQuality.default('original'),
  qualityCellular: StreamQuality.default('high'),
  downloadQuality: StreamQuality.default('original'),
  downloadOnWifiOnly: z.boolean().default(true),
  scrobbleListenBrainz: z.boolean().default(false),
  syncListenBrainzHearts: z.boolean().optional(),
  syncLastFmHearts: z.boolean().optional(),
  scrobbleLastFm: z.boolean().default(false),
  /**
   * Whether the user's library holds all of the server's music (its collection: scanned,
   * uploaded and inbox files), as well as what they saved. Off by default: a library is what
   * the user hearted, with their own uploads hearted for them. The server's music is listed
   * by `/collection/*` either way.
   */
  libraryIncludesServerMusic: z.boolean().default(false),
  shareNowPlaying: z.boolean().default(false),
})
export type UserSettings = z.infer<typeof UserSettings>
/** `PATCH /api/v1/me/settings`. Keys left out keep their value; there are no defaults here. */
export const UpdateUserSettings = z.object({
  normalization: NormalizationMode,
  qualityWifi: StreamQuality,
  qualityCellular: StreamQuality,
  downloadQuality: StreamQuality,
  downloadOnWifiOnly: z.boolean(),
  scrobbleListenBrainz: z.boolean(),
  syncListenBrainzHearts: z.boolean(),
  syncLastFmHearts: z.boolean(),
  scrobbleLastFm: z.boolean(),
  libraryIncludesServerMusic: z.boolean(),
  shareNowPlaying: z.boolean(),
}).partial()
export type UpdateUserSettings = z.infer<typeof UpdateUserSettings>

/** An http or https address: `new URL` on anything else throws, or fetches nothing. */
const HttpUrl = z.url({ protocol: /^https?$/ })

/**
 * Operator settings, stored in `server_settings`. Secrets are write-only: reads return
 * `…Set` booleans instead of the value.
 */
export const ServerSettings = z.object({
  serverName: z.string().default('Squirmy'),
  deezerEnabled: z.boolean().default(true),
  musicBrainzEnabled: z.boolean().default(true),
  // A value stored before it was validated must not break every lookup.
  musicBrainzBaseUrl: HttpUrl.default('https://musicbrainz.org').catch('https://musicbrainz.org'),
  coverArtArchiveEnabled: z.boolean().default(true),
  wikidataEnabled: z.boolean().default(true),
  lrclibEnabled: z.boolean().default(true),
  listenBrainzTokenSet: z.boolean().default(false),
  acoustIdKeySet: z.boolean().default(false),
  fanartKeySet: z.boolean().default(false),
  lastFmKeySet: z.boolean().default(false),
  /** Matches at or above this score are accepted without review. */
  matchAutoAcceptScore: z.number().min(0).max(1).default(0.9),
  /** Days a vanished file is kept before it is unlinked from the library. */
  fileHealthIntervalDays: z.number().int().min(0).max(365).default(7),
  missingFileGraceDays: z.number().int().min(0).max(365).default(14),
  transcodeCacheMaxBytes: z.number().int().min(0).default(10 * 1024 ** 3),
  registrationRequiresInvite: z.boolean().default(true),
  /** Managed root imports are filed into. Null means the only managed root, when there is exactly one. */
  importRootId: Id.nullable().default(null),
  /**
   * Folder the server watches for music to import. Items dropped here are moved into the
   * library. It may not be inside a library root. Null falls back to SQUIRMY_INBOX_PATH.
   */
  inboxPath: z.string().nullable().default(null),
  /** Largest single file an import accepts, archives included. */
  importMaxFileBytes: z.number().int().min(1).default(4 * 1024 ** 3),
  /** Largest import, counting what its archives extract to. */
  importMaxBytes: z.number().int().min(1).default(64 * 1024 ** 3),
  /**
   * Uploads one member may have receiving or processing at once; more are refused with
   * 429 `too_many_imports`. Admins are not limited.
   */
  importMaxActivePerUser: z.number().int().min(1).default(3),
  /**
   * Whether people can keep a wantlist of music the server does not have. Off by default:
   * with a provider that can fetch anything it is noise. Turning it off keeps the stored
   * wants, so turning it back on restores them.
   */
  wantlistEnabled: z.boolean().default(false),
  /**
   * Whether files are analysed for tempo, key, energy and timbre (the sonic analysis radio
   * uses). It runs in the background at the lowest priority. Off stops new analysis and
   * keeps what was measured; tempo, key and mood tags are read either way.
   */
  sonicAnalysisEnabled: z.boolean().default(true),
})
export type ServerSettings = z.infer<typeof ServerSettings>

/**
 * `PATCH /admin/settings`. Keys left out keep their value, so nothing here has a default.
 * A secret set to null or an empty string is removed.
 */
export const UpdateServerSettings = z.object({
  serverName: z.string(),
  deezerEnabled: z.boolean(),
  musicBrainzEnabled: z.boolean(),
  musicBrainzBaseUrl: HttpUrl,
  coverArtArchiveEnabled: z.boolean(),
  wikidataEnabled: z.boolean(),
  lrclibEnabled: z.boolean(),
  matchAutoAcceptScore: z.number().min(0).max(1),
  fileHealthIntervalDays: z.number().int().min(0).max(365),
  missingFileGraceDays: z.number().int().min(0).max(365),
  transcodeCacheMaxBytes: z.number().int().min(0),
  registrationRequiresInvite: z.boolean(),
  importRootId: Id.nullable(),
  inboxPath: z.string().nullable(),
  importMaxFileBytes: z.number().int().min(1),
  importMaxBytes: z.number().int().min(1),
  importMaxActivePerUser: z.number().int().min(1),
  wantlistEnabled: z.boolean(),
  sonicAnalysisEnabled: z.boolean(),
  listenBrainzToken: z.string().nullable(),
  acoustIdKey: z.string().nullable(),
  fanartKey: z.string().nullable(),
  lastFmKey: z.string().nullable(),
  lastFmSecret: z.string().nullable(),
}).partial()
export type UpdateServerSettings = z.infer<typeof UpdateServerSettings>
