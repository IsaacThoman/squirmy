/**
 * A mock acquisition provider for tests and demos. Whatever it is asked for, it delivers a
 * near-silent sine tone of the requested length, tagged with the requested title, artist,
 * album and identifiers. Switches make it slow, failing, wrong or priced, so every path of
 * the server's acquisition flow can be exercised. Needs ffmpeg.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { ProviderCoverage, ProviderOffer, ProviderRecordingQuery, ProviderResolveItem } from '@squirmy/contracts'
import { createProviderServer, ProviderBusyError, type DeliveryFile, type ProviderServer } from '@squirmy/provider-kit'

const run = promisify(execFile)

export type MockSettings = {
  secret: string
  coverage: ProviderCoverage
  kinds: ('recording' | 'album')[]
  /** Wait this long after accepting a job before delivering it. */
  delayMs: number
  /** Accept jobs, then report them failed. */
  fail: boolean
  /** Deliver a tone with a different title and length than the one asked for. */
  wrongFile: boolean
  /** Put a price on every offer. */
  priced: boolean
  /**
   * Changes what a delivered file says about itself, to stand in for a provider that tags
   * from its own catalog instead of from the request: another album title or year, no
   * identifiers, its own file names.
   */
  retag?: (track: MockTrack) => MockTrack
  /** Declines this many of the next new jobs as busy. */
  busyTimes: number
  /** Accepts jobs, then fails this many of the next ones as rate limited (`reason: "busy"`). */
  rateLimitedTimes: number
  /** The `version` it reports in `capabilities`; none by default. */
  version?: string
  /** The `maxConcurrent` it advertises. */
  maxConcurrent: number
  /** Which items it has; everything by default. */
  has: (item: ProviderResolveItem) => boolean
  /** Tones longer than this many seconds are cut short. */
  maxSeconds: number
  ffmpegPath: string
  /** Errors from background deliveries; printed by default. */
  onError?: (error: unknown) => void
}

export const defaultSettings: MockSettings = {
  secret: 'mock-provider-secret',
  coverage: 'assume_available',
  kinds: ['recording', 'album'],
  delayMs: 0,
  fail: false,
  wrongFile: false,
  priced: false,
  busyTimes: 0,
  rateLimitedTimes: 0,
  maxConcurrent: 4,
  has: () => true,
  maxSeconds: 1200,
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
}

export type MockProvider = ProviderServer & {
  /** Change switches at any time; they apply to the next request. */
  settings: MockSettings
  /** Every item it was asked to resolve, in order. */
  resolved: ProviderResolveItem[]
}

/** What one delivered file's tags say. `path` is its place inside the delivery when the provider names files itself. */
export type MockTrack = {
  title: string; artist: string; albumArtist?: string; album: string | null; durationMs: number | null; disc: number; position: number; total: number
  mbid: string | null; isrcs: string[]; year: number | null; path?: string
}
type Track = MockTrack

/** Writes one tagged tone, the way the server's test fixtures do: -50 dB, below the loudness gate. */
async function writeTone(settings: MockSettings, file: string, track: Track) {
  const seconds = Math.min(settings.maxSeconds, Math.max(1, Math.round((track.durationMs ?? 30_000) / 1000)))
  const tags: Record<string, string | number> = {
    title: track.title, artist: track.artist, album_artist: track.albumArtist ?? track.artist, track: `${track.position}/${track.total}`, disc: track.disc,
    ...(track.album ? { album: track.album } : {}),
    ...(track.year ? { date: track.year } : {}),
    ...(track.mbid ? { MUSICBRAINZ_TRACKID: track.mbid } : {}),
    ...(track.isrcs[0] ? { ISRC: track.isrcs[0] } : {}),
  }
  // A pitch of its own for each title and artist: the same recording sounds the same, others differ.
  const pitch = 200 + createHash('sha256').update(`${track.artist}\n${track.title}`).digest().readUInt16BE(0) % 800
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${pitch}:duration=${seconds}:sample_rate=44100`]
  args.push('-af', 'volume=-50dB', '-ac', '2', '-c:a', 'flac')
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`)
  args.push(file)
  await run(settings.ffmpegPath, args)
}

function recordingTrack(recording: ProviderRecordingQuery): Track {
  return {
    title: recording.title, artist: recording.artist, album: recording.album?.title ?? null, durationMs: recording.durationMs,
    disc: recording.album?.disc ?? 1, position: recording.album?.position ?? 1, total: recording.album?.position ?? 1,
    mbid: recording.mbid, isrcs: recording.isrcs, year: recording.album?.year ?? null,
  }
}

const safeName = (text: string) => text.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100)

/** Creates the mock provider. Call `listen()` to start it. */
export function createMockProvider(overrides: Partial<MockSettings> = {}): MockProvider {
  const settings: MockSettings = { ...defaultSettings, ...overrides }
  const resolved: ProviderResolveItem[] = []
  const offers = new Map<string, ProviderResolveItem>()
  let serial = 0

  const server = createProviderServer({
    secret: settings.secret,
    onError: (error) => (settings.onError ?? ((reason: unknown) => console.error('[mock provider]', reason)))(error),
    busy() {
      if (settings.busyTimes <= 0) return false
      settings.busyTimes -= 1
      return true
    },
    get capabilities() {
      return {
        name: 'Mock tones', coverage: settings.coverage, kinds: settings.kinds, formats: ['flac'], maxConcurrent: settings.maxConcurrent,
        ...(settings.version ? { version: settings.version } : {}),
      }
    },
    resolve(item) {
      resolved.push(item)
      if (!settings.kinds.includes(item.kind) || !settings.has(item)) return []
      const offerId = `tone:${++serial}`
      offers.set(offerId, item)
      const tracks = item.kind === 'album' ? item.album.tracks.length : 1
      const offer: ProviderOffer = {
        offerId, format: 'flac', lossless: true, sampleRate: 44_100, bitDepth: 16, etaSeconds: Math.ceil(settings.delayMs / 1000) + tracks,
        ...(settings.priced ? { price: { amount: '0.99', currency: 'USD' } } : {}),
      }
      return [offer]
    },
    async fetch(offerId, { signal }) {
      const item = offers.get(offerId)
      if (!item) throw new Error(`Unknown offer ${offerId}`)
      if (settings.delayMs > 0) await sleep(settings.delayMs, undefined, { signal })
      if (settings.fail) throw new Error('The mock provider was told to fail')
      if (settings.rateLimitedTimes > 0) {
        settings.rateLimitedTimes -= 1
        throw new ProviderBusyError('Rate limited by the source; try again shortly')
      }
      const tracks: Track[] = item.kind === 'recording'
        ? [recordingTrack(item.recording)]
        : item.album.tracks.filter((track) => track.wanted !== false).map((track) => ({
          title: track.title, artist: item.album.artist, album: item.album.title, durationMs: track.durationMs, disc: track.disc,
          position: track.position, total: item.album.tracks.filter((other) => other.disc === track.disc).length,
          mbid: track.recordingMbid, isrcs: track.isrcs, year: item.album.year,
        }))
      const folder = await mkdtemp(path.join(tmpdir(), 'squirmy-mock-provider-'))
      const files: DeliveryFile[] = []
      const albumFolder = safeName(`${tracks[0]?.artist ?? 'Unknown'} - ${tracks[0]?.album ?? 'Singles'}`)
      for (const original of tracks) {
        const wanted = settings.wrongFile
          ? { ...original, title: `${original.title} (Something Else)`, durationMs: (original.durationMs ?? 30_000) + 60_000, mbid: null, isrcs: [] }
          : original
        const track = settings.retag ? settings.retag(wanted) : wanted
        const name = `${String(track.position).padStart(2, '0')} ${safeName(track.title)}.flac`
        const file = path.join(folder, name)
        await mkdir(folder, { recursive: true })
        await writeTone(settings, file, track)
        files.push({ path: file, name: track.path ?? `${albumFolder}/${name}` })
      }
      return { files, cleanup: () => rm(folder, { recursive: true, force: true }) }
    },
  })
  return Object.assign(server, { settings, resolved })
}
