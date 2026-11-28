import { eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { serverSettings } from '../../database/schema.js'

const key = 'integrations'

export type IntegrationSettings = {
  allowLan: boolean
  mqtt: { url: string; username?: string; encryptedPassword?: string; topicPrefix: string } | null
}

export async function integrationSettings(): Promise<IntegrationSettings> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, key))
  return row ? row.value as IntegrationSettings : { allowLan: false, mqtt: null }
}

export async function saveIntegrationSettings(value: IntegrationSettings): Promise<void> {
  await db.insert(serverSettings).values({ key, value })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value, updatedAt: new Date() } })
}
