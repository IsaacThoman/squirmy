import { describe, expect, it } from 'vitest'
import { PlaybackDescriptor } from './playback.js'
import { ServerEvent, SessionCapability, SessionHelloAck, SignalReport } from './session.js'

const id = '00000000-0000-4000-8000-000000000001'

describe('ServerEvent', () => {
  it('reads the playback.unavailable notice', () => {
    const event = { type: 'playback.unavailable', trackId: null }
    expect(ServerEvent.parse(event)).toEqual(event)
  })
})

describe('signal path', () => {
  const report = {
    entryId: 'c1.0',
    trackId: id,
    source: { codec: 'flac', lossless: true, bitrate: 4_608_000, sampleRate: 96_000, bitDepth: 24, channels: 2, bytes: 52_000_000 },
    delivery: { profile: 'aac_256', transcoded: true, codec: 'aac', lossless: false, bitrate: 256_000, sampleRate: 48_000, bitDepth: null, reason: 'codec', local: false },
    normalization: { mode: 'auto', applied: 'track', gainDb: -4.2 },
  }

  it('reads a report, and one without the file from a device behind an older server', () => {
    expect(SignalReport.parse(report)).toEqual(report)
    expect(SignalReport.parse({ ...report, source: null }).source).toBeNull()
  })

  it('names the capability', () => {
    expect(SessionCapability.options).toContain('signal')
  })

  it('reads a hello answer with or without one', () => {
    const snapshot = {
      version: 1, queueVersion: 1,
      state: { current: null, playing: false, positionMs: 0, anchorAt: 0, stalled: false, activeDeviceId: null, shuffle: false, repeat: 'off', autoplay: true, context: null, volumes: {} },
      queue: { queue: [], history: [], autoplayQueue: [], playOrder: [], playedInCycle: [] },
    }
    expect(SessionHelloAck.parse({ serverTime: 0, snapshot, devices: [] }).signal).toBeUndefined()
    expect(SessionHelloAck.parse({ serverTime: 0, snapshot, devices: [], signal: { ...report, deviceId: 'tv' } }).signal?.deviceId).toBe('tv')
  })
})

describe('PlaybackDescriptor', () => {
  it('reads an older server\'s descriptor, which says nothing of the file', () => {
    const old = {
      trackId: id, albumId: null, fileId: id, url: '/x', expiresAt: '2026-01-01T00:00:00.000Z', profile: 'original', transcoded: false,
      mime: 'audio/flac', codec: 'flac', lossless: true, bitrate: null, sampleRate: 44_100, bitDepth: 16, durationMs: 1, bytes: null, normalization: null,
    }
    const parsed = PlaybackDescriptor.parse(old)
    expect(parsed.source).toBeUndefined()
    expect(parsed.transcodeReason).toBeUndefined()
  })
})
