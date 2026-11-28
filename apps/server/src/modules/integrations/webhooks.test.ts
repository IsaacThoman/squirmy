import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { webhookDeliveries } from '../../database/schema.js'
import { drainJobs, jobs, startJobs } from '../../jobs/index.js'
import { requestOutbound } from '../../lib/http.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { integrationsModule } from './index.js'
import { emitWebhook } from './webhooks.js'

describe('webhooks', () => {
  useTestDatabase()
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeAll(async () => {
    app = await buildApp()
    await integrationsModule.jobs!(jobs)
    await startJobs({ work: true })
  })
  afterAll(async () => { await app.close() })

  it('blocks private, link-local and loopback destinations unless explicitly allowed for RFC1918', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    try {
      for (const [url, allowLan] of [
        ['http://127.0.0.1/', true], ['http://169.254.169.254/', true], ['http://10.1.2.3/', false],
        ['http://[::ffff:127.0.0.1]/', true], ['http://[fc00::1]/', true], ['http://[2002:7f00:1::]/', true],
      ] as const) await expect(requestOutbound('test', url, {}, allowLan)).rejects.toThrow('allowed networks')
      expect(fetch).not.toHaveBeenCalled()
      await expect(requestOutbound('test', 'http://10.1.2.3/', {}, true)).resolves.toHaveProperty('status', 204)
    } finally {
      fetch.mockRestore()
    }
    await expect(requestOutbound('test', 'http://localhost:1/', {}, false)).rejects.toThrow()
  })

  it('signs posts, retries with the same event, and scopes delivery by owner', async () => {
    const messages: { raw: string; signature: string | undefined }[] = []
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      messages.push({ raw: Buffer.concat(chunks).toString(), signature: request.headers['x-squirmy-signature'] as string | undefined })
      response.writeHead(messages.length === 1 ? 503 : 204).end()
    })
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const port = (receiver.address() as AddressInfo).port
    const localFetch = globalThis.fetch
    // The socket destination policy is tested separately. Route the public test URL to the local receiver.
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, request) => localFetch(`http://127.0.0.1:${port}/`, {
      method: request?.method, body: request?.body, headers: request?.headers, redirect: request?.redirect,
    }))
    try {
      const user = await signIn()
      const stranger = await signIn()
      const admin = await signIn({ role: 'admin' })
      const created = await app.inject({ method: 'POST', url: '/api/v1/me/webhooks', headers: user.headers, payload: {
        name: 'Receiver', url: 'https://receiver.example/hooks', events: ['scrobble'],
      } })
      expect(created.statusCode).toBe(201)
      const { id, secret } = created.json()
      expect((await app.inject({ url: '/api/v1/me/webhooks', headers: user.headers })).json()[0].secret).toBeUndefined()
      expect((await app.inject({ method: 'POST', url: `/api/v1/me/webhooks/${id}/test`, headers: stranger.headers })).statusCode).toBe(404)
      await emitWebhook('scrobble', {}, stranger.id)
      expect(await db.select().from(webhookDeliveries)).toEqual([])
      await emitWebhook('scrobble', { count: 1 }, user.id)
      await drainJobs()
      expect(messages).toHaveLength(2)
      for (const message of messages) {
        expect(message.signature).toBe(`sha256=${createHmac('sha256', secret).update(message.raw).digest('hex')}`)
        expect(JSON.parse(message.raw)).toMatchObject({ type: 'scrobble', userId: user.id, data: { count: 1 } })
      }
      expect(messages[0]?.raw).toBe(messages[1]?.raw)
      const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, id))
      expect(delivery).toMatchObject({ attempts: 2, status: 'delivered', httpStatus: 204 })
      expect((await app.inject({ method: 'POST', url: `/api/v1/me/webhooks/${id}/test`, headers: user.headers })).statusCode).toBe(200)
      await drainJobs()
      expect((await app.inject({ url: '/api/v1/admin/webhook-deliveries', headers: admin.headers })).json()).toHaveLength(2)
    } finally {
      fetch.mockRestore()
      await new Promise<void>(resolve => receiver.close(() => resolve()))
    }
  })
})
