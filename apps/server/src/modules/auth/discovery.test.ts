import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetConfig } from '../../config.js'
import { registerLanDiscovery } from './discovery.js'

const { publish, unpublishAll, destroy } = vi.hoisted(() => ({
  publish: vi.fn(),
  unpublishAll: vi.fn((callback: () => void) => callback()),
  destroy: vi.fn((callback: () => void) => callback()),
}))
vi.mock('bonjour-service', () => ({
  default: class { publish = publish; unpublishAll = unpublishAll; destroy = destroy },
}))
vi.mock('../../lib/settings.js', () => ({ getServerSettings: async () => ({ serverName: 'Music Room' }) }))

describe('LAN discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    resetConfig()
  })

  it.each([
    { enabled: false, host: '0.0.0.0', advertised: false },
    { enabled: true, host: '127.0.0.1', advertised: false },
    { enabled: true, host: '0.0.0.0', advertised: true },
  ])('advertises when enabled and reachable ($enabled, $host)', async ({ enabled, host, advertised }) => {
    vi.stubEnv('DATABASE_URL', 'postgres://unused')
    vi.stubEnv('PUBLIC_URL', 'https://music.example.test')
    vi.stubEnv('SQUIRMY_LAN_DISCOVERY', String(enabled))
    resetConfig()
    const app = Fastify()
    registerLanDiscovery(app)
    expect(publish).not.toHaveBeenCalled()
    try {
      await app.listen({ host, port: 0 })
      if (advertised) {
        await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({
          name: expect.stringMatching(/^Music Room \(/),
          type: 'squirmy',
          host: expect.stringMatching(/\.local$/),
          port: Number(new URL(app.listeningOrigin!).port),
        }))
      } else {
        expect(publish).not.toHaveBeenCalled()
      }
    } finally {
      await app.close()
    }
    expect(unpublishAll).toHaveBeenCalledTimes(Number(advertised))
    expect(destroy).toHaveBeenCalledTimes(Number(advertised))
  })
})
