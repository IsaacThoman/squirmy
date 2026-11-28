import { createHash } from 'node:crypto'
import { artworkUrl, positionAt } from '@squirmy/client-core'
import { PlaybackControl } from '@squirmy/contracts'
import { connect, type MqttClient } from 'mqtt'
import { getConfig } from '../../config.js'
import { decrypt, hashToken } from '../../lib/crypto.js'
import { trackSummaries } from '../catalog/summaries.js'
import { controlPlayback, playingDevices } from '../sessions/service.js'
import { playbackState } from './playback.js'
import { integrationSettings, type IntegrationSettings } from './settings.js'

type Broker = NonNullable<IntegrationSettings['mqtt']>
type Device = ReturnType<typeof playingDevices>[number]
const qos = { qos: 1, retain: true } as const
const stopped = { state: 'stopped', title: null, artist: null, album: null, artUrl: null, positionMs: 0, volume: null }

export class MqttBridge {
  readonly #client: MqttClient
  readonly #availability: string
  readonly #states = new Map<string, { device: Device; attributes: object; trackId: string | null; payload: string }>()

  constructor(private readonly broker: Broker) {
    this.#availability = `${broker.topicPrefix}/availability`
    this.#client = connect(broker.url, {
      username: broker.username,
      password: broker.encryptedPassword ? decrypt('mqtt-password', broker.encryptedPassword) : undefined,
      clientId: `squirmy-${hashToken(broker.topicPrefix).slice(0, 16)}`,
      will: { topic: this.#availability, payload: 'offline', qos: 1, retain: true },
      queueQoSZero: false,
      connectTimeout: 5000,
      reconnectPeriod: 5000,
    })
    this.#client.on('error', error => {
      if (getConfig().LOG_LEVEL !== 'silent') console.warn('[mqtt]', error.message)
    })
    this.#client.on('connect', () => {
      this.#client.subscribe(`${broker.topicPrefix}/+/+/command`, { qos: 0 })
      for (const [topic, { payload }] of this.#states) {
        this.discover(topic)
        this.#client.publish(`${topic}/state`, payload, qos)
      }
      this.#client.publish(this.#availability, 'online', qos)
    })
    this.#client.on('message', (topic, body, packet) => {
      if (packet.retain || body.byteLength > 200 || !topic.endsWith('/command')) return
      const state = this.#states.get(topic.slice(0, -'/command'.length))
      if (!state) return
      let value: unknown
      try { value = JSON.parse(body.toString()) } catch { return }
      const command = PlaybackControl.safeParse(value)
      if (command.success) void controlPlayback(state.device.userId, command.data, state.device.deviceId).catch(() => {})
    })
  }

  private discover(topic: string) {
    const id = createHash('sha256').update(topic).digest('hex').slice(0, 24)
    this.#client.publish(`homeassistant/sensor/squirmy_${id}/config`, JSON.stringify({
      name: 'Squirmy playback', unique_id: `squirmy_${id}`, state_topic: `${topic}/state`,
      json_attributes_topic: `${topic}/state`, value_template: '{{ value_json.state }}',
      availability_topic: this.#availability,
    }), qos)
  }

  async refresh(devices: readonly Device[]) {
    if (!this.#client.connected) return
    const topics = new Set<string>()
    for (const device of devices) {
      const { userId, deviceId, session } = device
      const encodedDevice = Buffer.from(deviceId).toString('base64url')
      const topic = `${this.broker.topicPrefix}/${userId}/${encodedDevice}`
      topics.add(topic)
      const trackId = session.current?.trackId ?? null
      const previous = this.#states.get(topic)
      let attributes = previous?.attributes ?? stopped
      if (!previous || previous.trackId !== trackId) {
        const [track] = trackId ? await trackSummaries(userId, [{ id: trackId, albumId: session.current?.albumId }]) : []
        const base = getConfig().PUBLIC_URL ?? ''
        attributes = {
          trackId, deviceId, userId, title: track?.title ?? null, artist: track?.artistCredit ?? null,
          album: track?.album?.title ?? null, artUrl: artworkUrl(base, track?.album?.artwork, 300),
        }
      }
      if (!this.#client.connected) return
      const payload = JSON.stringify({
        ...attributes, state: playbackState(session), positionMs: Math.floor(positionAt(session, Date.now())),
        volume: session.volumes[deviceId] ?? null,
      })
      this.#states.set(topic, { device, attributes, trackId, payload })
      if (!previous) this.discover(topic)
      if (previous?.payload !== payload) this.#client.publish(`${topic}/state`, payload, qos)
    }
    for (const topic of this.#states.keys()) {
      if (topics.has(topic)) continue
      this.#client.publish(`${topic}/state`, JSON.stringify(stopped), qos)
      this.#states.delete(topic)
    }
  }

  async stop() {
    if (!this.#client.connected) {
      await this.#client.endAsync(true)
      return
    }
    for (const topic of this.#states.keys()) this.#client.publish(`${topic}/state`, JSON.stringify(stopped), qos)
    this.#client.publish(this.#availability, 'offline', qos)
    const force = setTimeout(() => this.#client.end(true), 2000)
    try { await this.#client.endAsync() } finally { clearTimeout(force) }
  }
}

let bridge: MqttBridge | undefined
let timer: ReturnType<typeof setInterval> | undefined
let revision: string | undefined
let inFlight: Promise<void> | undefined

async function refresh() {
  const { mqtt } = await integrationSettings()
  const next = JSON.stringify(mqtt)
  if (revision !== next) {
    await bridge?.stop()
    bridge = mqtt ? new MqttBridge(mqtt) : undefined
    revision = next
  }
  await bridge?.refresh(playingDevices())
}

export function startMqtt() {
  const tick = () => {
    inFlight ??= refresh().catch(error => {
      if (getConfig().LOG_LEVEL !== 'silent') console.warn('[mqtt]', (error as Error).message)
    }).finally(() => { inFlight = undefined })
  }
  tick()
  timer = setInterval(tick, 3000).unref()
}

export async function stopMqtt() {
  clearInterval(timer)
  await inFlight
  await bridge?.stop()
  bridge = undefined
  revision = undefined
}
