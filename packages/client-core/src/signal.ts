import type { NormalizationMode, PlaybackDescriptor, PlaybackSource, SignalReport, StreamProfile, TranscodeReason } from '@squirmy/contracts'
import { formatBytes } from './format.js'
import { REFERENCE_LUFS, type AppliedGain } from './normalization.js'

/**
 * The quality badge of Now Playing. `hi_res_lossless`: lossless above 48 kHz or 16 bits, as
 * streaming services draw the line; `lossless`: any other lossless stream. Lossy streams
 * get none: they are the ordinary case.
 */
export type AudioQuality = 'hi_res_lossless' | 'lossless'

type Facts = { lossless: boolean; sampleRate: number | null; bitDepth: number | null }

/** The badge for a stream or a file with these facts; null for lossy or unknown. */
export function audioQualityOf(facts: Facts | null | undefined): AudioQuality | null {
  if (!facts?.lossless) return null
  return (facts.sampleRate ?? 0) > 48_000 || (facts.bitDepth ?? 0) > 16 ? 'hi_res_lossless' : 'lossless'
}

/** The badge for what is playing: what reaches the device, so a lossless file played as a transcode shows none. */
export function signalQuality(signal: Pick<SignalReport, 'delivery'> | null | undefined): AudioQuality | null {
  return audioQualityOf(signal?.delivery)
}

export function audioQualityLabel(quality: AudioQuality): string {
  return quality === 'hi_res_lossless' ? 'Hi-Res Lossless' : 'Lossless'
}

/**
 * What a device that plays `descriptor` for `entryId` reports (see "Signal path" in the
 * session contract). `normalization` is what the device applies to it (`appliedGain`'s
 * answer, with the device's mode and target); `local` that it plays a copy on the device.
 */
export function signalReport(
  entryId: string,
  descriptor: PlaybackDescriptor,
  normalization: AppliedGain & { mode: NormalizationMode; targetLufs?: number },
  local: boolean,
): SignalReport {
  const applied = normalization.mode === 'off' ? null : normalization.applied
  return {
    entryId,
    trackId: descriptor.trackId,
    source: descriptor.source ?? (descriptor.transcoded ? null : sourceOfOriginal(descriptor)),
    delivery: {
      profile: descriptor.profile,
      transcoded: descriptor.transcoded,
      codec: descriptor.codec,
      lossless: descriptor.lossless,
      bitrate: descriptor.bitrate,
      sampleRate: descriptor.sampleRate,
      bitDepth: descriptor.bitDepth,
      reason: descriptor.transcoded ? descriptor.transcodeReason ?? null : null,
      local,
    },
    normalization: {
      mode: normalization.mode,
      applied,
      // Rounded so a report is sent again only when the change can be heard.
      gainDb: applied ? tenths(20 * Math.log10(normalization.gain)) : null,
      ...applied && normalization.targetLufs !== undefined ? { targetLufs: normalization.targetLufs } : {},
      ...applied && normalization.limitDb !== undefined ? { limitDb: normalization.limitDb === null ? null : tenths(normalization.limitDb) } : {},
    },
  }
}

const tenths = (value: number) => Math.round(value * 10) / 10

/** An older server's descriptor of an original describes the file, all but its channels. */
function sourceOfOriginal(descriptor: PlaybackDescriptor): PlaybackSource {
  const { codec, lossless, bitrate, sampleRate, bitDepth, bytes } = descriptor
  return { codec, lossless, bitrate, sampleRate, bitDepth, channels: null, bytes }
}

const codecNames: Record<string, string> = {
  flac: 'FLAC', alac: 'Apple Lossless', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Ogg Vorbis', wav: 'WAV', aiff: 'AIFF',
}

/** `flac` → `FLAC`, `alac` → `Apple Lossless`; anything else in capitals. */
export function codecLabel(codec: string): string {
  return codecNames[codec.toLowerCase()] ?? codec.toUpperCase()
}

/** `44100` → `44.1 kHz`, `96000` → `96 kHz`. */
export function formatSampleRate(hz: number): string {
  const khz = hz / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

/** Bits per second as `256 kbps`, `1,411 kbps`. */
export function formatBitrate(bitsPerSecond: number): string {
  return `${Math.round(bitsPerSecond / 1000).toLocaleString('en-US')} kbps`
}

export function channelsLabel(channels: number): string {
  return channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels} channels`
}

const profileNames: Record<Exclude<StreamProfile, 'original'>, string> = {
  aac_256: 'AAC 256 kbps', opus_128: 'Opus 128 kbps', mp3_320: 'MP3 320 kbps', mp3_192: 'MP3 192 kbps',
  flac_mp4: 'FLAC', opus_mp4_192: 'Opus 192 kbps', opus_mp4_96: 'Opus 96 kbps',
  aac_mp4_256: 'AAC 256 kbps', aac_mp4_128: 'AAC 128 kbps', copy_mp4: 'Fragmented MP4',
}

const reasonNames: Record<TranscodeReason, string> = {
  quality: 'Your streaming quality setting',
  codec: 'The device can’t play the original format',
}

const modeNames: Record<NormalizationMode, string> = { off: 'Off', track: 'Per song', album: 'Per album', auto: 'Automatic' }

/** `-14` → `−14 LUFS`. */
export function formatLoudness(lufs: number): string {
  return `${lufs < 0 ? '−' : ''}${Math.abs(lufs)} LUFS`
}

/** `-3.24` → `−3.2 dB`, `1` → `+1.0 dB`. */
export function formatGain(db: number): string {
  const rounded = Math.round(db * 10) / 10
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : ''
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`
}

export type TrackInfoRow = { label: string; value: string }
export type TrackInfoSection = { title: string; rows: TrackInfoRow[] }

/**
 * The audio sections of a Track Info sheet, worded alike on every client: the file, how it
 * reaches the device, and loudness normalization. Rows the report does not know are left out.
 */
export function signalSections(signal: SignalReport): TrackInfoSection[] {
  const { source, delivery, normalization } = signal
  const sections: TrackInfoSection[] = []
  if (source) {
    const quality = audioQualityOf(source)
    sections.push({
      title: 'File',
      rows: compact([
        { label: 'Format', value: quality ? `${codecLabel(source.codec)} · ${audioQualityLabel(quality)}` : codecLabel(source.codec) },
        source.sampleRate ? { label: 'Sample rate', value: formatSampleRate(source.sampleRate) } : null,
        source.bitDepth ? { label: 'Bit depth', value: `${source.bitDepth}-bit` } : null,
        source.bitrate ? { label: 'Bitrate', value: formatBitrate(source.bitrate) } : null,
        source.channels ? { label: 'Channels', value: channelsLabel(source.channels) } : null,
        source.bytes ? { label: 'File size', value: formatBytes(source.bytes) } : null,
      ]),
    })
  }
  const stream = delivery.profile === 'copy_mp4' ? `${codecLabel(delivery.codec)} in fragmented MP4` : delivery.transcoded
    ? `Transcoded to ${delivery.profile === 'original' ? codecLabel(delivery.codec) : profileNames[delivery.profile]}`
    : 'Original file'
  sections.push({
    title: 'Playback',
    rows: compact([
      { label: 'Stream', value: stream },
      delivery.reason ? { label: 'Why', value: reasonNames[delivery.reason] } : null,
      delivery.transcoded && delivery.sampleRate ? { label: 'Sample rate', value: formatSampleRate(delivery.sampleRate) } : null,
      { label: 'From', value: delivery.local ? 'A copy on the device' : 'Streamed from the server' },
    ]),
  })
  const applied = normalization.applied
  sections.push({
    title: 'Volume normalization',
    rows: compact([
      { label: 'Setting', value: modeNames[normalization.mode] },
      normalization.mode === 'off' ? null : {
        label: 'Applied',
        value: applied && normalization.gainDb !== null
          ? `${applied === 'album' ? 'Album' : 'Song'} level, ${formatGain(normalization.gainDb)}`
          : 'None: no loudness data for this song',
      },
      applied ? { label: 'Target', value: formatLoudness(normalization.targetLufs ?? REFERENCE_LUFS) } : null,
      applied && normalization.limitDb !== undefined ? { label: 'Peak limiter', value: limiterValue(normalization.limitDb) } : null,
    ]),
  })
  return sections
}

/** What the limiter does to the song: nothing, how much at most, or unknown without its peak. */
function limiterValue(limitDb: number | null): string {
  if (limitDb === null) return 'On'
  return limitDb > 0 ? `Turns the loudest peaks down by up to ${limitDb.toFixed(1)} dB` : 'Not needed for this song'
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null)
}
