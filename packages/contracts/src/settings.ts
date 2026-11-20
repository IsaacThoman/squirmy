import { z } from 'zod'
import { patchOf } from './common.js'
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
export const UpdateUserSettings = patchOf(UserSettings)
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

export const UpdateServerSettings = patchOf(ServerSettings.omit({
  listenBrainzTokenSet: true, acoustIdKeySet: true, fanartKeySet: true, lastFmKeySet: true,
})).extend({
  listenBrainzToken: z.string().nullable().optional(),
  acoustIdKey: z.string().nullable().optional(),
  fanartKey: z.string().nullable().optional(),
  lastFmKey: z.string().nullable().optional(),
  lastFmSecret: z.string().nullable().optional(),
})
export type UpdateServerSettings = z.infer<typeof UpdateServerSettings>
