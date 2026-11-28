#!/usr/bin/env node
/**
 * squirmy-speaker: a headless Squirmy Connect speaker. Configured by environment variables
 * (docs/server/speaker.md). Commands:
 *
 *   squirmy-speaker           run: pair if not signed in, then play whatever is sent here
 *   squirmy-speaker unpair    forget the sign-in (the next run pairs again)
 *   squirmy-speaker --help
 */
import { createApiClient } from '@squirmy/client-core'
import type { ClientDevice, TvPairing } from '@squirmy/contracts'
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { renderUnicodeCompact } from 'uqr'
import { loadConfig } from './config.js'
import { ffmpegDecoder } from './decoder.js'
import { PcmEngine } from './engine.js'
import { alsaMixer } from './mixer.js'
import { createSink, outputFormat } from './output.js'
import { pairSpeaker } from './pairing.js'
import { startSpeaker, type Speaker } from './speaker.js'
import { loadState, saveState, type SpeakerState } from './state.js'
import { findServer, type SpeakerStatus, startStatusPage } from './status.js'

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

function log(message: string, error?: unknown) {
  const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? '' : `: ${String(error)}`
  console.log(`${new Date().toISOString()} ${message}${detail}`)
}

const help = `squirmy-speaker ${version}: plays your Squirmy session on this computer's sound card.

Usage:
  squirmy-speaker          Pair if needed, then wait for music
  squirmy-speaker unpair   Forget this speaker's sign-in

Settings are environment variables (SQUIRMY_SERVER, SQUIRMY_SPEAKER_NAME,
SQUIRMY_SPEAKER_DEVICE…). See https://github.com/IsaacThoman/squirmy/blob/dev/docs/server/speaker.md`

async function main() {
  const command = process.argv[2]
  if (command === '--help' || command === '-h' || command === 'help') return console.log(help)
  if (command === '--version') return console.log(version)
  if (command && command !== 'unpair' && command !== 'run') throw new Error(`Unknown command ${command}. Try --help.`)

  const config = loadConfig()
  const state: SpeakerState = await loadState(config.stateDir)
  if (command === 'unpair') {
    await saveState(config.stateDir, { deviceId: state.deviceId })
    return log('Signed out. The next start pairs this speaker again.')
  }

  const device: ClientDevice = { id: state.deviceId, name: config.name, kind: 'speaker' }
  const stop = new AbortController()
  let speaker: Speaker | null = null
  const status: SpeakerStatus = {
    name: config.name, deviceId: device.id, version, server: null, pairing: null, account: state.account ?? null, connection: 'offline', playing: null,
  }
  const page = config.statusPort > 0
    ? await startStatusPage({ port: config.statusPort, mdns: config.mdns, status: () => ({ ...status, playing: playingHere() }), onLog: log }).catch((error: unknown) => {
      log(`Could not open the status page on port ${config.statusPort}`, error)
      return null
    })
    : null
  if (page) log(`Status page on port ${config.statusPort}`)

  const engine = new PcmEngine({
    decoder: ffmpegDecoder({ ffmpegPath: config.ffmpegPath, onLog: line => log(`ffmpeg: ${line}`) }),
    sink: createSink(config),
    formatFor: media => outputFormat(config, media),
    leadMs: config.bufferMs,
    onLog: log,
  })

  const shutdown = () => {
    stop.abort()
    speaker?.stop()
    engine.dispose()
    void page?.close().finally(() => process.exit(0))
    if (!page) process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  while (!stop.signal.aborted) {
    const server = config.server ?? state.server ?? await discover()
    if (!server) continue
    status.server = server
    if (!state.token || state.server !== server) {
      const api = createApiClient({ baseUrl: server, client: 'speaker' })
      const signedIn = await pairSpeaker(api, device, { signal: stop.signal, onCode: pairing => showCode(pairing) }).catch(async (error: unknown) => {
        if (stop.signal.aborted) return null
        log(`Pairing with ${server} failed; trying again in 10 s`, error)
        await sleep(10_000, undefined, { signal: stop.signal }).catch(() => {})
        return null
      })
      if (!signedIn) continue
      state.server = server
      state.token = signedIn.token
      state.account = signedIn.user.displayName ?? signedIn.user.username
      await saveState(config.stateDir, state)
      status.pairing = null
      status.account = state.account ?? null
      page?.refresh()
      log(`Paired with ${server} as ${state.account}`)
    }

    let signOut = () => {}
    const signedOut = new Promise<void>(resolve => { signOut = resolve })
    const running = startSpeaker({
      server, token: state.token!, device, engine, quality: config.quality, onLog: log,
      mixer: config.mixer ? alsaMixer(config.mixer.control, config.mixer.card, log) : null,
      onSignedOut: () => signOut(),
    })
    speaker = running
    let connection = status.connection
    running.client.subscribe(() => {
      const snapshot = running.client.getSnapshot()
      status.connection = snapshot.connection
      if (snapshot.connection !== connection) {
        connection = snapshot.connection
        if (connection === 'online') log(`Connected to ${server} as “${config.name}”`)
        if (connection === 'offline') log(`Lost the connection to ${server}; reconnecting`)
      }
    })
    stop.signal.addEventListener('abort', () => signOut(), { once: true })
    await signedOut
    running.stop()
    speaker = null
    if (stop.signal.aborted) break
    log('The server signed this speaker out; pairing again')
    delete state.token
    delete state.account
    status.account = null
    await saveState(config.stateDir, state)
    page?.refresh()
  }

  function playingHere(): SpeakerStatus['playing'] {
    if (!speaker?.client.getSnapshot().isActiveDevice) return null
    const { state, entryId } = engine.getStatus()
    return { state, entryId }
  }

  async function discover(): Promise<string | null> {
    if (!config.mdns) throw new Error('Set SQUIRMY_SERVER to the server’s address (LAN discovery is off).')
    log('Looking for a Squirmy server on the LAN (set SQUIRMY_SERVER to skip this)')
    const found = await findServer(10_000, log)
    if (found) log(`Found ${found}`)
    else await sleep(5000, undefined, { signal: stop.signal }).catch(() => {})
    return found
  }

  function showCode(pairing: TvPairing) {
    status.pairing = { userCode: pairing.userCode, verificationUrl: pairing.verificationUrl, qrCode: pairing.qrCode, expiresAt: pairing.expiresAt }
    page?.refresh()
    log(`To play to “${config.name}”, open ${pairing.verificationUrl} on a phone or computer signed in to Squirmy, or enter the code ${pairing.userCode} in Settings → Security → Add a speaker.`)
    console.log(renderUnicodeCompact(pairing.verificationUrl))
  }
}

main().catch((error: unknown) => {
  log('squirmy-speaker stopped', error)
  process.exit(1)
})
