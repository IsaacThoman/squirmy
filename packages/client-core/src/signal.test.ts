import type { PlaybackDescriptor } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { audioQualityOf, codecLabel, formatBitrate, formatGain, formatLoudness, formatSampleRate, signalQuality, signalReport, signalSections } from './signal.js'

const id = '00000000-0000-4000-8000-000000000001'

function descriptor(overrides: Partial<PlaybackDescriptor> = {}): PlaybackDescriptor {
  return {
    trackId: id, albumId: null, fileId: id, url: '/api/v1/stream/x', expiresAt: new Date(0).toISOString(),
    profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac', lossless: true,
    bitrate: 4_608_000, sampleRate: 96_000, bitDepth: 24, durationMs: 1000, bytes: 1_000_000, normalization: null,
    source: { codec: 'flac', lossless: true, bitrate: 4_608_000, sampleRate: 96_000, bitDepth: 24, channels: 2, bytes: 1_000_000 },
    transcodeReason: null,
    ...overrides,
  }
}

const off = { mode: 'off' as const, applied: null, gain: 1 }

describe('audioQualityOf', () => {
  it('draws the hi-res line above 48 kHz or 16 bits', () => {
    expect(audioQualityOf({ lossless: true, sampleRate: 44_100, bitDepth: 16 })).toBe('lossless')
    expect(audioQualityOf({ lossless: true, sampleRate: 48_000, bitDepth: 16 })).toBe('lossless')
    expect(audioQualityOf({ lossless: true, sampleRate: 96_000, bitDepth: 24 })).toBe('hi_res_lossless')
    expect(audioQualityOf({ lossless: true, sampleRate: 44_100, bitDepth: 24 })).toBe('hi_res_lossless')
    expect(audioQualityOf({ lossless: true, sampleRate: null, bitDepth: null })).toBe('lossless')
  })

  it('gives lossy streams no badge', () => {
    expect(audioQualityOf({ lossless: false, sampleRate: 96_000, bitDepth: null })).toBeNull()
    expect(audioQualityOf(null)).toBeNull()
  })
})

describe('signalReport', () => {
  it('badges what is delivered, not the file', () => {
    const transcoded = descriptor({ profile: 'aac_256', transcoded: true, codec: 'aac', lossless: false, bitrate: 256_000, sampleRate: 48_000, bitDepth: null, transcodeReason: 'quality' })
    const report = signalReport('e1', transcoded, off, false)
    expect(signalQuality(report)).toBeNull()
    expect(report.source?.bitDepth).toBe(24)
    expect(report.delivery).toMatchObject({ profile: 'aac_256', reason: 'quality', local: false })
    expect(signalQuality(signalReport('e1', descriptor(), off, false))).toBe('hi_res_lossless')
  })

  it('takes an older server\'s original as the file, and knows nothing of a transcode\'s', () => {
    const { source: _source, transcodeReason: _reason, ...old } = descriptor()
    expect(signalReport('e1', old, off, false).source).toMatchObject({ codec: 'flac', sampleRate: 96_000, channels: null })
    const oldTranscode = { ...old, profile: 'mp3_320' as const, transcoded: true, codec: 'mp3', lossless: false }
    expect(signalReport('e1', oldTranscode, off, false)).toMatchObject({ source: null, delivery: { reason: null } })
  })

  it('states the gain applied in dB, rounded', () => {
    const report = signalReport('e1', descriptor(), { mode: 'auto', applied: 'album', gain: 10 ** (-3.24 / 20) }, false)
    expect(report.normalization).toEqual({ mode: 'auto', applied: 'album', gainDb: -3.2 })
  })

  it('states the target, and what the limiter does when there is one', () => {
    const boosted = { mode: 'track' as const, applied: 'track' as const, gain: 10 ** (5.04 / 20), targetLufs: -14, limitDb: 2.26 }
    expect(signalReport('e1', descriptor(), boosted, false).normalization).toEqual({ mode: 'track', applied: 'track', gainDb: 5, targetLufs: -14, limitDb: 2.3 })
    expect(signalReport('e1', descriptor(), { ...boosted, limitDb: null }, false).normalization.limitDb).toBeNull()
    // Nothing of either while nothing is applied.
    expect(signalReport('e1', descriptor(), { ...off, targetLufs: -14, limitDb: 0 }, false).normalization).toEqual({ mode: 'off', applied: null, gainDb: null })
  })
})

describe('signalSections', () => {
  it('words the file, the stream and normalization', () => {
    const transcoded = descriptor({ profile: 'opus_128', transcoded: true, codec: 'opus', lossless: false, bitrate: 128_000, sampleRate: 48_000, bitDepth: null, transcodeReason: 'quality' })
    const sections = signalSections(signalReport('e1', transcoded, { mode: 'track', applied: 'track', gain: 10 ** (-6 / 20) }, true))
    expect(sections.map(section => section.title)).toEqual(['File', 'Playback', 'Volume normalization'])
    expect(sections[0]!.rows).toEqual([
      { label: 'Format', value: 'FLAC · Hi-Res Lossless' },
      { label: 'Sample rate', value: '96 kHz' },
      { label: 'Bit depth', value: '24-bit' },
      { label: 'Bitrate', value: '4,608 kbps' },
      { label: 'Channels', value: 'Stereo' },
      { label: 'File size', value: '977 KB' },
    ])
    expect(sections[1]!.rows).toEqual([
      { label: 'Stream', value: 'Transcoded to Opus 128 kbps' },
      { label: 'Why', value: 'Your streaming quality setting' },
      { label: 'Sample rate', value: '48 kHz' },
      { label: 'From', value: 'A copy on the device' },
    ])
    expect(sections[2]!.rows).toEqual([
      { label: 'Setting', value: 'Per song' },
      { label: 'Applied', value: 'Song level, −6.0 dB' },
      { label: 'Target', value: '−18 LUFS' },
    ])
  })

  it('words the target and the limiter', () => {
    const rows = (normalization: Parameters<typeof signalReport>[2]) => signalSections(signalReport('e1', descriptor(), normalization, false))[2]!.rows
    const boosted = { mode: 'track' as const, applied: 'track' as const, gain: 10 ** (5 / 20), targetLufs: -14 }
    expect(rows({ ...boosted, limitDb: 2.26 })).toEqual([
      { label: 'Setting', value: 'Per song' },
      { label: 'Applied', value: 'Song level, +5.0 dB' },
      { label: 'Target', value: '−14 LUFS' },
      { label: 'Peak limiter', value: 'Turns the loudest peaks down by up to 2.3 dB' },
    ])
    expect(rows({ ...boosted, limitDb: 0 }).at(-1)).toEqual({ label: 'Peak limiter', value: 'Not needed for this song' })
    expect(rows({ ...boosted, limitDb: null }).at(-1)).toEqual({ label: 'Peak limiter', value: 'On' })
    // A device without a limiter, or from before targets: no limiter row, and -18.
    expect(rows({ ...boosted, targetLufs: undefined }).map(row => row.value)).toEqual(['Per song', 'Song level, +5.0 dB', '−18 LUFS'])
  })

  it('leaves out what normalization does not do', () => {
    const [, , normalization] = signalSections(signalReport('e1', descriptor(), off, false))
    expect(normalization!.rows).toEqual([{ label: 'Setting', value: 'Off' }])
  })
})

describe('formatting', () => {
  it('formats rates, bitrates, gains and codecs', () => {
    expect(formatSampleRate(44_100)).toBe('44.1 kHz')
    expect(formatSampleRate(192_000)).toBe('192 kHz')
    expect(formatBitrate(1_411_200)).toBe('1,411 kbps')
    expect(formatGain(1)).toBe('+1.0 dB')
    expect(formatGain(0)).toBe('0.0 dB')
    expect(formatLoudness(-14)).toBe('−14 LUFS')
    expect(codecLabel('alac')).toBe('Apple Lossless')
    expect(codecLabel('wv')).toBe('WV')
  })
})
