import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { db } from './database/client.js'
import { users } from './database/schema.js'
import { newId } from './lib/ids.js'
import { useTestDatabase } from './test/database.js'

describe('server kernel', () => {
  useTestDatabase()

  it('answers the health check', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'squirmy' })
    await app.close()
  })

  it('has a migrated database with trigram search', async () => {
    await db.insert(users).values({ id: newId(), username: 'Isaac', usernameKey: 'isaac', passwordHash: 'x' })
    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
    const [row] = await db.execute<{ score: number }>(sql`select similarity('radiohead', 'radiohed') as score`)
    expect(Number(row?.score)).toBeGreaterThan(0.5)
  })
})
