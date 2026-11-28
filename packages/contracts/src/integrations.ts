import { z } from 'zod'
import { Id, IsoDateTime } from './common.js'

export const WebhookEventType = z.enum([
  'playback.started', 'playback.paused', 'playback.stopped', 'playback.track_changed',
  'scrobble', 'library.scan_finished', 'library.album_added', 'import.finished',
])
export type WebhookEventType = z.infer<typeof WebhookEventType>

export const WebhookEvent = z.object({
  id: Id,
  type: z.union([WebhookEventType, z.literal('test')]),
  at: IsoDateTime,
  userId: Id.nullable(),
  data: z.record(z.string(), z.unknown()),
})
export type WebhookEvent = z.infer<typeof WebhookEvent>

export const CreateWebhook = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(1000).pipe(z.url({ protocol: /^https?$/ })),
  events: z.array(WebhookEventType).min(1).max(WebhookEventType.options.length),
})
export type CreateWebhook = z.infer<typeof CreateWebhook>

export const Webhook = CreateWebhook.extend({ id: Id, secret: z.string().optional() })
export type Webhook = z.infer<typeof Webhook>

export const WebhookDelivery = z.object({
  id: Id,
  webhookId: Id,
  name: z.string(),
  event: WebhookEvent.shape.type,
  attempts: z.number().int(),
  status: z.enum(['queued', 'retrying', 'delivered', 'failed']),
  httpStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  updatedAt: IsoDateTime,
})
export type WebhookDelivery = z.infer<typeof WebhookDelivery>

const MqttBroker = z.object({
  url: z.string().trim().max(500).pipe(z.url({ protocol: /^mqtts?$/ })),
  username: z.string().max(200).optional(),
  topicPrefix: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
})
export const IntegrationConfig = z.object({
  allowLan: z.boolean(),
  mqtt: MqttBroker.extend({ passwordSet: z.boolean() }).nullable(),
})
export type IntegrationConfig = z.infer<typeof IntegrationConfig>

export const UpdateIntegrationConfig = z.object({
  allowLan: z.boolean(),
  mqtt: MqttBroker.extend({ password: z.string().max(1000).nullable().optional() }).nullable(),
})
export type UpdateIntegrationConfig = z.infer<typeof UpdateIntegrationConfig>

export const PlaybackControl = z.union([
  z.object({ type: z.enum(['play', 'pause', 'next', 'previous']) }),
  z.object({ type: z.literal('volume'), value: z.number().min(0).max(1) }),
])
export type PlaybackControl = z.infer<typeof PlaybackControl>
