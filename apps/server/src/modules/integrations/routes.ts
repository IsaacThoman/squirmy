import {
  CreateWebhook, Id, type IntegrationConfig, type Ok, UpdateIntegrationConfig, type Webhook, type WebhookDelivery,
} from '@squirmy/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { users, webhookDeliveries, webhooks } from '../../database/schema.js'
import { requireAdmin, requireUser } from '../../lib/auth.js'
import { encrypt, randomToken } from '../../lib/crypto.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { integrationSettings, saveIntegrationSettings } from './settings.js'
import { queueWebhook, webhookEvent, webhookSecretPurpose } from './webhooks.js'

const Params = z.object({ id: Id })
const hookFields = { id: webhooks.id, name: webhooks.name, url: webhooks.url, events: webhooks.events }

async function config(): Promise<IntegrationConfig> {
  const { allowLan, mqtt } = await integrationSettings()
  return { allowLan, mqtt: mqtt && { url: mqtt.url, username: mqtt.username, topicPrefix: mqtt.topicPrefix, passwordSet: !!mqtt.encryptedPassword } }
}

export async function integrationRoutes(app: FastifyInstance) {
  for (const admin of [false, true]) {
    const path = admin ? '/admin/webhooks' : '/me/webhooks'
    const owner = (request: FastifyRequest) => admin ? (requireAdmin(request), null) : requireUser(request).id
    const owned = (userId: string | null) => userId === null ? isNull(webhooks.userId) : eq(webhooks.userId, userId)

    app.get(path, async (request): Promise<Webhook[]> => db.select(hookFields).from(webhooks).where(owned(owner(request))).orderBy(webhooks.name))

    app.post(path, async (request, reply): Promise<Webhook> => {
      const userId = owner(request)
      const body = CreateWebhook.parse(request.body)
      const url = new URL(body.url)
      if (url.username || url.password || url.hash) throw badRequest('Use a URL without embedded credentials or a fragment')
      const secret = randomToken(32)
      const record = { ...body, url: url.href, events: [...new Set(body.events)], id: newId() }
      await db.transaction(async tx => {
        if (userId) await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update')
        else await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:admin-webhooks'))`)
        const held = await tx.select({ id: webhooks.id }).from(webhooks).where(owned(userId)).limit(10)
        if (held.length === 10) throw conflict('Up to 10 webhooks can be configured')
        await tx.insert(webhooks).values({ ...record, userId, secretEncrypted: encrypt(webhookSecretPurpose, secret) })
      })
      reply.code(201)
      return { ...record, secret }
    })

    app.delete(`${path}/:id`, async (request): Promise<Ok> => {
      const userId = owner(request)
      const { id } = Params.parse(request.params)
      const removed = await db.delete(webhooks).where(and(eq(webhooks.id, id), owned(userId))).returning({ id: webhooks.id })
      if (!removed.length) throw notFound()
      return { ok: true }
    })

    app.post(`${path}/:id/test`, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request): Promise<Ok> => {
      const userId = owner(request)
      const { id } = Params.parse(request.params)
      const [hook] = await db.select({ id: webhooks.id }).from(webhooks).where(and(eq(webhooks.id, id), owned(userId)))
      if (!hook) throw notFound()
      await queueWebhook(id, webhookEvent('test', {}, userId))
      return { ok: true }
    })
  }

  app.get('/admin/webhook-deliveries', async (request): Promise<WebhookDelivery[]> => {
    requireAdmin(request)
    const rows = await db.select({ delivery: webhookDeliveries, name: webhooks.name }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .orderBy(desc(webhookDeliveries.updatedAt)).limit(100)
    return rows.map(({ delivery, name }) => ({ ...delivery, name, updatedAt: delivery.updatedAt.toISOString() }))
  })

  app.get('/admin/integrations', async (request): Promise<IntegrationConfig> => {
    requireAdmin(request)
    return config()
  })

  app.put('/admin/integrations', async (request): Promise<IntegrationConfig> => {
    requireAdmin(request)
    const patch = UpdateIntegrationConfig.parse(request.body)
    const previous = await integrationSettings()
    const broker = patch.mqtt
    if (broker) {
      const url = new URL(broker.url)
      if (!url.hostname || url.username || url.password || url.pathname !== '' && url.pathname !== '/' || url.search || url.hash) {
        throw badRequest('Use a broker URL with a hostname and optional port. Enter credentials separately.')
      }
    }
    await saveIntegrationSettings({
      allowLan: patch.allowLan,
      mqtt: broker && {
        url: broker.url,
        username: broker.username,
        topicPrefix: broker.topicPrefix,
        encryptedPassword: broker.password === undefined && broker.url === previous.mqtt?.url && broker.username === previous.mqtt?.username
          ? previous.mqtt?.encryptedPassword
          : broker.password ? encrypt('mqtt-password', broker.password) : undefined,
      },
    })
    return config()
  })
}
