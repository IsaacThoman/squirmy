import path from 'node:path'
import type { StreamProfile } from '@squirmy/contracts'
import type { mediaFiles } from '../../database/schema.js'

export type MediaFile = typeof mediaFiles.$inferSelect
export type TranscodeProfile = Exclude<StreamProfile, 'original'>

export type ProfileSpec = {
  /** Codec family of the output, in the vocabulary clients use in `codecs`. */
  codec: string
  /** Target bitrate in bits per second. */
  bitrate: number
  /** Highest output sample rate; the source rate is kept when it is lower. */
  maxSampleRate: number
  mime: string
  extension: string
  /** Encoder and muxer arguments. Every container here can be written to a pipe as it is played. */
  args: string[]
}

/**
 * Every transcode profile. Encoders are ffmpeg's native `aac`, `libopus` and `libmp3lame`,
 * which the macOS builds and Ubuntu's `ffmpeg` package all include.
 *
 * - AAC goes in ADTS rather than MP4: an MP4 needs its index written after the audio, so
 *   the bytes streamed during encoding would not be the bytes cached.
 * - Opus goes in Ogg: Chrome and Firefox always played it, Safari since 18.4, and an Ogg
 *   stream is final as written. WebM would need its header rewritten at the end.
 * - MP3 is constant bitrate without a Xing frame, which ffmpeg can only fill in by seeking.
 */
export const profiles: Record<TranscodeProfile, ProfileSpec> = {
  aac_256: {
    codec: 'aac', bitrate: 256_000, maxSampleRate: 48_000, mime: 'audio/aac', extension: 'aac',
    args: ['-c:a', 'aac', '-b:a', '256k', '-f', 'adts', '-write_id3v2', '1'],
  },
  opus_128: {
    codec: 'opus', bitrate: 128_000, maxSampleRate: 48_000, mime: 'audio/ogg', extension: 'opus',
    args: ['-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg'],
  },
  mp3_320: {
    codec: 'mp3', bitrate: 320_000, maxSampleRate: 48_000, mime: 'audio/mpeg', extension: 'mp3',
    args: ['-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', '-write_xing', '0', '-id3v2_version', '3'],
  },
  mp3_192: {
    codec: 'mp3', bitrate: 192_000, maxSampleRate: 48_000, mime: 'audio/mpeg', extension: 'mp3',
    args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', '-write_xing', '0', '-id3v2_version', '3'],
  },
}

/** What a client is assumed to decode when it sends no codec list: any current browser or OS. */
export const defaultCodecs: ReadonlySet<string> = new Set(['mp3', 'aac', 'flac', 'alac', 'opus', 'vorbis', 'wav', 'aiff'])

/** Parses a `codecs` query value ("flac, MP3,aac") into a set, or the defaults when absent. */
export function parseCodecs(codecs: string | undefined): ReadonlySet<string> {
  const list = codecs?.split(',').map((codec) => codec.trim().toLowerCase()).filter(Boolean)
  return list?.length ? new Set(list) : defaultCodecs
}

const extensionOf = (file: Pick<MediaFile, 'relPath'>) => path.extname(file.relPath).slice(1).toLowerCase()

/**
 * The file's codec in the client vocabulary (mp3, aac, flac, alac, opus, vorbis, wav,
 * aiff…). Tag readers name codecs loosely ("MPEG 1 Layer 3", "Vorbis I", "PCM"), so this
 * matches on substrings and falls back to the extension.
 */
export function codecFamily(file: Pick<MediaFile, 'codec' | 'container' | 'relPath'>): string {
  const codec = file.codec.toLowerCase()
  const extension = extensionOf(file)
  const named = ['flac', 'alac', 'opus', 'vorbis', 'aac', 'mp3', 'aiff', 'wav'].find((family) => codec.includes(family))
  if (named) return named
  if (codec.includes('layer 3') || codec.includes('layer iii')) return 'mp3'
  if (codec.includes('mp4a')) return 'aac'
  if (codec.includes('pcm')) return ['aif', 'aiff', 'aifc'].includes(extension) || file.container.toLowerCase().includes('aif') ? 'aiff' : 'wav'
  return codec || extension
}

const mimeByExtension: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  mka: 'audio/x-matroska',
  wv: 'audio/wavpack',
  ape: 'audio/x-ape',
  dsf: 'audio/x-dsf',
}

/**
 * The Content-Type to serve an original file with. The extension decides the container;
 * `audio/mp4` and `audio/ogg` cover every codec they can hold.
 */
export function mimeFor(file: Pick<MediaFile, 'relPath'>): string {
  return mimeByExtension[extensionOf(file)] ?? 'application/octet-stream'
}

/**
 * The sample rate a transcode is written at: the source rate when the encoder takes it,
 * otherwise the highest rate of the same family (88.2 kHz becomes 44.1). Opus always runs
 * at 48 kHz. Null when the source rate is unknown, which leaves the choice to ffmpeg.
 */
export function outputSampleRate(file: Pick<MediaFile, 'sampleRate'>, profile: TranscodeProfile): number | null {
  const { maxSampleRate } = profiles[profile]
  if (profile === 'opus_128') return maxSampleRate
  const source = file.sampleRate
  if (!source || source <= maxSampleRate) return source
  return source % 44_100 === 0 ? 44_100 : maxSampleRate
}
