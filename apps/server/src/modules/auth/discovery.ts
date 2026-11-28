import Bonjour from 'bonjour-service'
import type { FastifyInstance } from 'fastify'
import { hostname } from 'node:os'
import { getConfig } from '../../config.js'
import { getServerSettings } from '../../lib/settings.js'

export function registerLanDiscovery(app: FastifyInstance) {
  const config = getConfig()
  if (!config.SQUIRMY_LAN_DISCOVERY) return

  let advertiser: Bonjour | undefined
  app.addHook('onListen', async () => {
    const address = app.server.address()
    if (!address || typeof address === 'string' || address.address === '::1' || /^127\./.test(address.address)) return
    const { serverName } = await getServerSettings()
    const machine = hostname().split('.')[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50).replace(/^-+|-+$/g, '') || 'squirmy'
    // A .local SRV target resolves through Bonjour even when the OS hostname belongs to another DNS domain.
    const host = `${machine}.local`
    // Servers often share a display name and port. Include the machine in the service instance name.
    const suffix = ` (${machine.slice(0, 24)}:${address.port})`
    const label = Buffer.from(serverName).subarray(0, 63 - Buffer.byteLength(suffix)).toString().replace(/\uFFFD$/, '')
    advertiser = new Bonjour({}, (error: unknown) => app.log.warn({ err: error }, 'LAN discovery unavailable'))
    advertiser.publish({ name: label + suffix, type: 'squirmy', host, port: address.port })
  })
  app.addHook('onClose', async () => {
    const active = advertiser
    if (!active) return
    advertiser = undefined
    await new Promise<void>(resolve => active.unpublishAll(() => active.destroy(resolve)))
  })
}
