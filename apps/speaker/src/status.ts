import Bonjour from 'bonjour-service'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** What the status page shows. Never the token. */
export type SpeakerStatus = {
  name: string
  deviceId: string
  version: string
  server: string | null
  /** Waiting for someone to approve this code. */
  pairing: { userCode: string; verificationUrl: string; qrCode: string; expiresAt: string } | null
  account: string | null
  connection: 'offline' | 'connecting' | 'online'
  /** What plays here, when this speaker is the active device. */
  playing: { state: string; entryId: string | null } | null
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

function page(status: SpeakerStatus): string {
  const body = status.pairing
    ? `<p>To play to this speaker, approve it from a phone or browser signed in to Squirmy.</p>
<p class="code">${escape(status.pairing.userCode)}</p>
<p><img alt="QR code for the approval page" width="220" height="220" src="${escape(status.pairing.qrCode)}"></p>
<p><a href="${escape(status.pairing.verificationUrl)}">${escape(status.pairing.verificationUrl)}</a></p>`
    : status.account
      ? `<p>Signed in to ${escape(status.server ?? 'Squirmy')} as ${escape(status.account)}. Pick <b>${escape(status.name)}</b> in any Squirmy app’s device list to play here.</p>
<p>${status.connection === 'online' ? (status.playing ? (status.playing.state === 'playing' ? 'Playing.' : status.playing.state === 'buffering' || status.playing.state === 'loading' ? 'Loading…' : 'Paused.') : 'Ready.') : 'Connecting to the server…'}</p>`
      : `<p>Looking for a Squirmy server…</p>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>${escape(status.name)}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
.code{font:600 2rem ui-monospace,monospace;letter-spacing:.1em}img{background:#fff;border-radius:8px}small{color:GrayText}</style></head>
<body><h1>${escape(status.name)}</h1>${body}<p><small>Squirmy speaker ${escape(status.version)}</small></p></body></html>`
}

/**
 * A small page on the LAN (`http://<host>:4790`) with the pairing code and its QR code, for a
 * speaker with no screen, and `status.json` for scripts. With `mdns`, the page is advertised as
 * `_squirmy-speaker._tcp` so Bonjour browsers and apps on the LAN can find unpaired speakers.
 */
export async function startStatusPage(options: {
  port: number
  mdns: boolean
  status: () => SpeakerStatus
  onLog: (message: string, error?: unknown) => void
}): Promise<{ url: string; refresh: () => void; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const status = options.status()
    if (request.method !== 'GET') return void response.writeHead(405).end()
    response.setHeader('cache-control', 'no-store')
    if (request.url === '/status.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status))
      return
    }
    if (request.url !== '/') return void response.writeHead(404).end()
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    }).end(page(status))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  let bonjour: Bonjour | null = null
  let advertised = ''
  const advertise = () => {
    if (!options.mdns) return
    const status = options.status()
    const txt = { id: status.deviceId, paired: status.account ? '1' : '0', v: status.version }
    const key = JSON.stringify([status.name, txt])
    if (key === advertised) return
    advertised = key
    try {
      if (!bonjour) bonjour = new Bonjour({}, (error: unknown) => options.onLog('LAN advertisement unavailable', error))
      bonjour.unpublishAll()
      bonjour.publish({ name: status.name.slice(0, 63), type: 'squirmy-speaker', port, txt })
    } catch (error) {
      options.onLog('LAN advertisement unavailable', error)
    }
  }
  advertise()
  return {
    url: `http://localhost:${port}`,
    refresh: advertise,
    close: async () => {
      const active = bonjour
      bonjour = null
      if (active) await new Promise<void>(resolve => active.unpublishAll(() => active.destroy(() => resolve())))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Finds Squirmy servers advertised on the LAN (`_squirmy._tcp`, see the server's `discovery.ts`). */
export async function findServer(timeoutMs: number, onLog: (message: string, error?: unknown) => void): Promise<string | null> {
  let bonjour: Bonjour
  try {
    bonjour = new Bonjour({}, (error: unknown) => onLog('LAN discovery unavailable', error))
  } catch (error) {
    onLog('LAN discovery unavailable', error)
    return null
  }
  return new Promise(resolve => {
    const browser = bonjour.find({ type: 'squirmy' }, service => {
      const address = service.addresses?.find(candidate => /^\d+\.\d+\.\d+\.\d+$/.test(candidate)) ?? service.host
      finish(`http://${address}:${service.port}`)
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
    let done = false
    function finish(url: string | null) {
      if (done) return
      done = true
      clearTimeout(timer)
      browser.stop()
      bonjour.destroy()
      resolve(url)
    }
  })
}
