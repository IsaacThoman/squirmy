import { ServerSettings, type UpdateServerSettings } from '@squirmy/contracts'
import { eq, like } from 'drizzle-orm'
import { db } from '../database/client.js'
import { serverSettings } from '../database/schema.js'
import { decrypt, encrypt } from './crypto.js'

/** Operator secrets. Stored encrypted, one row each, under `secret:<name>`. */
export type ServerSecretName = 'listenBrainzToken' | 'acoustIdKey' | 'fanartKey' | 'lastFmKey' | 'lastFmSecret'

const secretNames: ServerSecretName[] = ['listenBrainzToken', 'acoustIdKey', 'fanartKey', 'lastFmKey', 'lastFmSecret']
const settingsKey = 'settings'
const cacheMs = 5_000

let cache: { value: ServerSettings; at: number } | undefined

/** Drop the cached copy. Call after a write, and in tests that change the database. */
export function invalidateServerSettings() {
  cache = undefined
}

/** Current operator settings with defaults applied. Cached for a few seconds. */
export async function getServerSettings(): Promise<ServerSettings> {
  if (cache && Date.now() - cache.at < cacheMs) return cache.value
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, settingsKey))
  const secrets = await db.select({ key: serverSettings.key }).from(serverSettings).where(like(serverSettings.key, 'secret:%'))
  const present = new Set(secrets.map((secret) => secret.key.slice('secret:'.length)))
  const value = ServerSettings.parse({
    ...(row?.value as Record<string, unknown> | undefined),
    listenBrainzTokenSet: present.has('listenBrainzToken'),
    acoustIdKeySet: present.has('acoustIdKey'),
    fanartKeySet: present.has('fanartKey'),
    lastFmKeySet: present.has('lastFmKey') && present.has('lastFmSecret'),
  })
  cache = { value, at: Date.now() }
  return value
}

export async function getServerSecret(name: ServerSecretName): Promise<string | null> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, `secret:${name}`))
  const ciphertext = (row?.value as { ciphertext?: string } | undefined)?.ciphertext
  return ciphertext ? decrypt('server-secret', ciphertext) : null
}

async function setServerSecret(name: ServerSecretName, value: string | null) {
  const key = `secret:${name}`
  if (!value) {
    await db.delete(serverSettings).where(eq(serverSettings.key, key))
    return
  }
  const stored = { ciphertext: encrypt('server-secret', value) }
  await db.insert(serverSettings).values({ key, value: stored })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: stored, updatedAt: new Date() } })
}

/** Applies a partial update. A secret set to null or '' is removed; undefined leaves it alone. */
export async function updateServerSettings(patch: UpdateServerSettings): Promise<ServerSettings> {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if ((secretNames as string[]).includes(key)) await setServerSecret(key as ServerSecretName, value as string | null)
    else plain[key] = value
  }
  if (Object.keys(plain).length > 0) {
    const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, settingsKey))
    const next = { ...(row?.value as Record<string, unknown> | undefined), ...plain }
    await db.insert(serverSettings).values({ key: settingsKey, value: next })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: next, updatedAt: new Date() } })
  }
  invalidateServerSettings()
  return getServerSettings()
}
