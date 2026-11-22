import { z } from 'zod'
import { Id, IsoDateTime } from './common.js'

/** `original` serves the file untouched. The rest are ffmpeg transcodes. */
export const StreamProfile = z.enum(['original', 'aac_256', 'opus_128', 'mp3_320', 'mp3_192'])
export type StreamProfile = z.infer<typeof StreamProfile>

/** What the caller wants: a fixed profile, or let the server decide from `codecs`. */
export const StreamQuality = z.enum(['original', 'high', 'data_saver'])
export type StreamQuality = z.infer<typeof StreamQuality>

export const PlaybackQuery = z.object({
  /** Album context; prefers the file that belongs to this album. */
  albumId: Id.optional(),
  quality: StreamQuality.default('original'),
  /** Comma separated codec list. Missing means "anything the browser/OS plays". */
  codecs: z.string().optional(),
  /** Marks the response for saving to the device rather than streaming. Accepts true/false and 1/0. */
  download: z.union([z.boolean(), z.stringbool()]).optional(),
})
export type PlaybackQuery = z.infer<typeof PlaybackQuery>

/**
 * Loudness data for client-side normalization. Gains are dB relative to a -18 LUFS
 * reference (ReplayGain 2.0); peaks are linear (1.0 = full scale): true peaks when the
 * server measured the file, the tagged sample peaks otherwise.
 */
export const Normalization = z.object({
  trackGainDb: z.number().nullable(),
  albumGainDb: z.number().nullable(),
  trackPeak: z.number().nullable(),
  albumPeak: z.number().nullable(),
})
export type Normalization = z.infer<typeof Normalization>

export const NormalizationMode = z.enum(['off', 'track', 'album', 'auto'])
export type NormalizationMode = z.infer<typeof NormalizationMode>

/** `GET /tracks/:id/playback`. `url` is signed, relative to the server origin. */
export const PlaybackDescriptor = z.object({
  trackId: Id,
  albumId: Id.nullable(),
  fileId: Id,
  url: z.string(),
  expiresAt: IsoDateTime,
  profile: StreamProfile,
  transcoded: z.boolean(),
  mime: z.string(),
  codec: z.string(),
  lossless: z.boolean(),
  bitrate: z.number().int().nullable(),
  sampleRate: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Byte size when known; lets downloads show progress. */
  bytes: z.number().int().nullable(),
  normalization: Normalization.nullable(),
})
export type PlaybackDescriptor = z.infer<typeof PlaybackDescriptor>
