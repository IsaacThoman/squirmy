import { createHmac } from 'node:crypto'
import type { WebhookEvent, WebhookEventType } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { webhookDeliveries, webhooks } from '../../database/schema.js'
import { enqueue, type JobContext } from '../../jobs/index.js'
import { decrypt } from '../../lib/crypto.js'
import { RefusedUrlError, requestOutbound } from '../../lib/http.js'
import { newId } from '../../lib/ids.js'
import { integrationSettings } from './settings.js'

export const webhookSecretPurpose = 'webhook-secret'
export const webhookRetryLimit = 3
export type WebhookJob = { deliveryId: string; event: WebhookEvent }

export async function queueWebhook(webhookId: string, event: WebhookEvent): Promise<void> {
  await db.transaction(async tx => {
    const [delivery] = await tx.insert(webhookDeliveries).values({ id: newId(), webhookId, eventId: event.id, event: event.type })
      .onConflictDoNothing().returning({ id: webhookDeliveries.id })
    if (delivery) await enqueue<WebhookJob>('integrations.webhook', { deliveryId: delivery.id, event }, { tx })
  })
}

export function webhookEvent(type: WebhookEvent['type'], data: WebhookEvent['data'], userId: string | null, id = newId()): WebhookEvent {
  return { id, type, data, userId, at: new Date().toISOString() }
}

/** Hooks are best effort at event sources and independently retried once queued. */
export async function emitWebhook(type: WebhookEventType, data: WebhookEvent['data'], userId: string | null = null, id?: string): Promise<void> {
  try {
    const event = webhookEvent(type, data, userId, id)
    const targets = await db.execute<{ id: string }>(sql`
      select w.id from webhooks w left join users u on u.id = w.user_id
      where (w.user_id is null or (u.disabled_at is null
        and (w.user_id = ${userId}::uuid or ${type} in ('library.scan_finished', 'library.album_added'))))
      and ${type} = any(w.events)`)
    for (const target of targets) await queueWebhook(target.id, event)
  } catch (error) {
    if (getConfig().LOG_LEVEL !== 'silent') console.error('[webhook] unable to queue', type, error)
  }
}

/** The receiver can deduplicate retries using the event ID in the signed body. */
export async function deliverWebhook({ deliveryId, event }: WebhookJob, { attempt }: JobContext): Promise<void> {
  const [row] = await db.select({ delivery: webhookDeliveries, hook: webhooks })
    .from(webhookDeliveries).innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(eq(webhookDeliveries.id, deliveryId))
  if (!row || row.delivery.status === 'delivered' || row.delivery.status === 'failed') return

  let httpStatus: number | null = null
  let error: string | null = null
  let retry = false
  try {
    const body = JSON.stringify(event)
    const signature = createHmac('sha256', decrypt(webhookSecretPurpose, row.hook.secretEncrypted)).update(body).digest('hex')
    const { allowLan } = await integrationSettings()
    const response = await requestOutbound('webhook', row.hook.url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'X-Squirmy-Signature': `sha256=${signature}`, 'X-Squirmy-Event': event.type },
      timeoutMs: 10_000,
    }, allowLan)
    httpStatus = response.status
    await response.body?.cancel()
    if (!response.ok) {
      error = `HTTP ${response.status}`
      retry = response.status >= 500 || [408, 425, 429].includes(response.status)
    }
  } catch (cause) {
    error = cause instanceof RefusedUrlError ? cause.message : 'Could not reach destination'
    retry = !(cause instanceof RefusedUrlError)
  }
  retry &&= attempt <= webhookRetryLimit
  await db.update(webhookDeliveries).set({
    attempts: attempt, status: error === null ? 'delivered' : retry ? 'retrying' : 'failed', error, httpStatus, updatedAt: new Date(),
  }).where(eq(webhookDeliveries.id, deliveryId))
  if (retry) throw new Error(error ?? 'Webhook delivery failed')
}

export async function pruneWebhookDeliveries() {
  await db.delete(webhookDeliveries).where(sql`${webhookDeliveries.updatedAt} < now() - interval '30 days'`)
}
