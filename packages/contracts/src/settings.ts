import { z } from 'zod'
import { NormalizationMode, StreamQuality } from './playback.js'

/** Per-user preferences, stored on the user row. */
export const UserSettings = z.object({
  normalization: NormalizationMode.default('auto'),
  qualityWifi: StreamQuality.default('original'),
  qualityCellular: StreamQuality.default('high'),
  downloadQuality: StreamQuality.default('original'),
  downloadOnWifiOnly: z.boolean().default(true),
  scrobbleListenBrainz: z.boolean().default(false),
  scrobbleLastFm: z.boolean().default(false),
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
  scrobbleLastFm: z.boolean(),
}).partial()
export type UpdateUserSettings = z.infer<typeof UpdateUserSettings>

/**
 * Operator settings, stored in `server_settings`. Secrets are write-only: reads return
 * `…Set` booleans instead of the value.
 */
export const ServerSettings = z.object({
  serverName: z.string().default('Squirmy'),
  deezerEnabled: z.boolean().default(true),
  musicBrainzEnabled: z.boolean().default(true),
  musicBrainzBaseUrl: z.string().default('https://musicbrainz.org'),
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
  missingFileGraceDays: z.number().int().min(0).max(365).default(14),
  transcodeCacheMaxBytes: z.number().int().min(0).default(10 * 1024 ** 3),
  registrationRequiresInvite: z.boolean().default(true),
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
  musicBrainzBaseUrl: z.string(),
  coverArtArchiveEnabled: z.boolean(),
  wikidataEnabled: z.boolean(),
  lrclibEnabled: z.boolean(),
  matchAutoAcceptScore: z.number().min(0).max(1),
  missingFileGraceDays: z.number().int().min(0).max(365),
  transcodeCacheMaxBytes: z.number().int().min(0),
  registrationRequiresInvite: z.boolean(),
  listenBrainzToken: z.string().nullable(),
  acoustIdKey: z.string().nullable(),
  fanartKey: z.string().nullable(),
  lastFmKey: z.string().nullable(),
  lastFmSecret: z.string().nullable(),
}).partial()
export type UpdateServerSettings = z.infer<typeof UpdateServerSettings>
