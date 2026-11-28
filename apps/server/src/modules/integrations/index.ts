import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { startMqtt, stopMqtt } from './mqtt.js'
import { integrationRoutes } from './routes.js'
import { deliverWebhook, pruneWebhookDeliveries, webhookRetryLimit } from './webhooks.js'

export const integrationsModule: ServerModule = {
  name: 'integrations',
  routes: integrationRoutes,
  async jobs(jobs) {
    jobs.define('integrations.webhook', { concurrency: 4, retryLimit: webhookRetryLimit, timeoutSeconds: 30 }, deliverWebhook)
    jobs.define('integrations.prune', {}, pruneWebhookDeliveries)
    await schedule('integrations.prune', '20 4 * * *')
  },
  start({ role }) {
    if (role !== 'worker') startMqtt()
  },
  stop: stopMqtt,
}
