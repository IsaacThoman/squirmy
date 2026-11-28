import { createApiClient, followsJam, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import { type ClientDevice, queryKeys, type StreamQuality, type UserSettings } from '@squirmy/contracts'
import { io } from 'socket.io-client'
import type { PcmEngine } from './engine.js'

/**
 * Codecs the speaker decodes (everything ffmpeg does). With `containers=fmp4` and the native
 * engine, the server then sends originals as they are, and FLAC in fragmented MP4 (`flac_mp4`)
 * for a lossless file in any other codec; at High or Data saver, Opus in fragmented MP4.
 */
export const SPEAKER_CODECS = 'flac,alac,wav,aiff,mp3,aac,opus,vorbis'

/** Songs in a row that fail before the speaker stops skipping and pauses. */
const FAILURES_BEFORE_PAUSE = 3

export type SpeakerOptions = {
  server: string
  token: string
  device: ClientDevice
  engine: PcmEngine
  /** Unset: the account's Wi-Fi quality setting. */
  quality?: StreamQuality
  /** Hardware volume. Unset: volume scales the samples. */
  mixer?: { set(volume: number): void } | null
  /** The session's and the engine's clock. Defaults to `Date.now`. */
  now?: () => number
  /** The server rejected the sign-in: the speaker was signed out (or the account disabled). */
  onSignedOut: () => void
  onLog: (message: string, error?: unknown) => void
  /** Replaces socket.io's own (for tests). */
  socket?: (server: string, token: string) => SquirmySocket
  reportIntervalMs?: number
}

export type Speaker = {
  client: SessionClient
  socket: SquirmySocket
  stop(): void
}

/**
 * Runs the speaker as a Squirmy Connect device: a `SessionClient` that can play, with the PCM
 * engine as its output, on a socket that reconnects by itself. It never starts playing on its
 * own; it plays when someone transfers the session to it, and does what the session says.
 */
export function startSpeaker(options: SpeakerOptions): Speaker {
  const { server, token, device, engine, onLog } = options
  let signedOut = false
  const signOut = () => {
    if (signedOut) return
    signedOut = true
    options.onSignedOut()
  }
  const api = createApiClient({ baseUrl: server, getToken: () => token, client: 'speaker', onUnauthorized: signOut })
  const socket: SquirmySocket = options.socket?.(server, token) ?? io(server, {
    path: '/socket.io', transports: ['websocket'], auth: { token }, autoConnect: false,
    reconnectionDelay: 1000, reconnectionDelayMax: 15_000,
  })
  let quality: StreamQuality = options.quality ?? 'original'
  let failures = 0

  const client = new SessionClient({
    transport: createSocketTransport(socket),
    device,
    now: options.now,
    reportIntervalMs: options.reportIntervalMs,
    player: {
      engine,
      baseUrl: server,
      // Gains are applied to integer samples with no limiter after them, so normalization is
      // held to each song's peak and never turns a song up.
      canBoost: false,
      limiter: false,
      systemVolume: Boolean(options.mixer),
      resolvePlayback: entry => api.streaming.playback(entry.trackId, {
        albumId: entry.albumId ?? undefined, quality, codecs: SPEAKER_CODECS, containers: 'fmp4', engine: 'native',
      }).then(descriptor => ({ ...descriptor, cacheKey: null })),
      onLoadError: (entry, error, willRetry) => {
        onLog(`Could not get ${entry.trackId} from the server${willRetry ? '; retrying' : ''}`, error)
        if (!willRetry) skip(entry.id)
      },
    },
  })

  /** Moves past a song that cannot play, as the apps do, unless several in a row failed. */
  function skip(entryId: string) {
    const { session, isActiveDevice } = client.getSnapshot()
    if (!isActiveDevice || session.current?.id !== entryId || followsJam(session)) return
    failures++
    if (failures >= FAILURES_BEFORE_PAUSE) {
      onLog(`${failures} songs in a row could not play; pausing`)
      failures = 0
      client.dispatch({ type: 'pause' })
      return
    }
    client.dispatch({ type: 'next' })
  }

  const cleanup: (() => void)[] = []
  cleanup.push(engine.subscribe(event => {
    if (event.type === 'error') {
      onLog(`Could not play entry ${event.entryId}: ${event.message}`)
      skip(event.entryId)
    }
    if (event.type === 'status' && event.status.state === 'playing') failures = 0
  }))

  const applySettings = (settings: UserSettings) => {
    client.setNormalization(settings.normalization)
    client.setNormalizationTarget(settings.normalizationTarget)
    if (!options.quality) quality = settings.qualityWifi
  }
  const loadSettings = () => api.userdata.settings().then(applySettings, (error: unknown) => onLog('Could not read the account’s settings', error))
  const settingsKey = queryKeys.settings()[0]
  socket.on('invalidate', ({ keys }) => {
    if (keys.some(key => key[0] === settingsKey)) void loadSettings()
  })
  socket.on('connect', () => void loadSettings())
  socket.on('connect_error', error => {
    if (error.message === 'unauthorized') signOut()
    else onLog(`Could not reach ${server}: ${error.message}`)
  })

  if (options.mixer) {
    const mixer = options.mixer
    let volume: number | undefined
    cleanup.push(client.subscribe(() => {
      const next = client.getSnapshot().session.volumes[device.id]
      if (next === undefined || next === volume) return
      volume = next
      mixer.set(next)
    }))
  }

  client.start()
  socket.connect()
  return {
    client,
    socket,
    stop() {
      for (const undo of cleanup.splice(0)) undo()
      client.dispose()
      engine.stop()
      socket.disconnect()
    },
  }
}
