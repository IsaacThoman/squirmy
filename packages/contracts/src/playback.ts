import { z } from 'zod'
import { Id, IsoDateTime } from './common.js'

/** `original` serves the file untouched. `copy_mp4` repackages its audio packets. */
export const StreamProfile = z.enum([
  'original', 'aac_256', 'opus_128', 'mp3_320', 'mp3_192',
  'flac_mp4', 'opus_mp4_192', 'opus_mp4_96', 'aac_mp4_256', 'aac_mp4_128', 'copy_mp4',
])
export type StreamProfile = z.infer<typeof StreamProfile>

/** Why a client is opening a stream, in encoder scheduling order. */
export const StreamIntent = z.enum(['play', 'next', 'cache', 'download'])
export type StreamIntent = z.infer<typeof StreamIntent>

/** What the caller wants: a fixed profile, or let the server decide from `codecs`. */
export const StreamQuality = z.enum(['original', 'high', 'data_saver'])
export type StreamQuality = z.infer<typeof StreamQuality>

export const PlaybackQuery = z.object({
  /** Album context; prefers the file that belongs to this album. */
  albumId: Id.optional(),
  quality: StreamQuality.default('original'),
  /** Comma separated codec list. With MSE, `mp3` means audio/mpeg and `mp3_mp4` means MP3 in MP4. */
  codecs: z.string().optional(),
  /** Opt in to fragmented MP4 delivery. Omit for the original set of streaming profiles. */
  containers: z.literal('fmp4').optional(),
  /** Disambiguates native and MSE clients with the same codecs. By default Opus signals native. */
  engine: z.enum(['native', 'mse']).optional(),
  /** Marks the response for saving to the device rather than streaming. Accepts true/false and 1/0. */
  download: z.union([z.boolean(), z.stringbool()]).optional(),
  /** Adds this scheduling hint to the returned stream URL. */
  intent: StreamIntent.optional(),
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
  /** The track gain comes from the library median; its peak is unknown. */
  estimated: z.boolean().optional(),
})
export type Normalization = z.infer<typeof Normalization>

export const NormalizationMode = z.enum(['off', 'track', 'album', 'auto'])
export type NormalizationMode = z.infer<typeof NormalizationMode>

/**
 * The loudness normalization brings songs to, in LUFS: the user's setting. -18 is the
 * reference of `Normalization`'s gains (ReplayGain 2.0), -14 about as loud as the big
 * streaming services, -23 broadcast level (EBU R 128). Above -18, quiet songs need turning
 * up, which a client does fully only with a limiter (see `gainFor` in client-core).
 */
export const NormalizationTarget = z.union([z.literal(-14), z.literal(-16), z.literal(-18), z.literal(-23)])
export type NormalizationTarget = z.infer<typeof NormalizationTarget>

/**
 * The file a stream is made from, whatever reaches the client. `codec` is in the vocabulary
 * of `codecs` (flac, alac, mp3, aac…); `bytes` is the file's size.
 */
export const PlaybackSource = z.object({
  codec: z.string(),
  lossless: z.boolean(),
  bitrate: z.number().int().nullable(),
  sampleRate: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  channels: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
})
export type PlaybackSource = z.infer<typeof PlaybackSource>

/**
 * Why a stream is a transcode. `quality`: the quality asked for (High, Data saver) is below
 * the file. `codec`: the client does not decode the file's codec.
 */
export const TranscodeReason = z.enum(['quality', 'codec'])
export type TranscodeReason = z.infer<typeof TranscodeReason>

/**
 * `GET /tracks/:id/playback`. `url` is signed, relative to the server origin. `codec`,
 * `lossless`, `bitrate`, `sampleRate`, `bitDepth` and `bytes` describe what the URL delivers:
 * after a transcode, the transcode. `source` describes the file.
 */
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
  /**
   * Exact decoded length at the delivered sample rate, before adding encoder delay or
   * trailing padding. A decoder that has already applied priming (e.g. Opus dOps) must
   * account for that before trimming. Null while source measurements are unavailable.
   *
   * For a fragmented MP4 live seek, append unsigned `start` (milliseconds) to the URL.
   * `X-Squirmy-Start-Frame` is the stream's offset at this sample rate. Encode seeks
   * still have the stated encoder delay; remux seeks after frame zero use packet
   * preroll instead. `frames` always describes the whole track. Cached URLs support Range.
   */
  gapless: z.object({
    sampleRate: z.number().int().positive(),
    primingFrames: z.number().int().nonnegative(),
    frames: z.number().int().positive(),
  }).nullish(),
  /** The file the stream is made from. Absent from older servers. */
  source: PlaybackSource.optional(),
  /** Why the stream is transcoded; null when it is not. Absent from older servers. */
  transcodeReason: TranscodeReason.nullable().optional(),
})
export type PlaybackDescriptor = z.infer<typeof PlaybackDescriptor>
