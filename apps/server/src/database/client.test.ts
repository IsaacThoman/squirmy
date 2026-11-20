import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { useTestDatabase } from '../test/database.js'
import { closeDb, db, getSql } from './client.js'

describe('database client', () => {
  useTestDatabase()

  it('refuses to reconnect after a final close, until the next close', async () => {
    await closeDb({ final: true })
    expect(() => getSql()).toThrow('The database is closed')
    await expect((async () => db.execute(sql`select 1`))()).rejects.toThrow('The database is closed')

    // A file with several test databases closes again before using the next one.
    await closeDb()
    expect([...await db.execute<{ one: number }>(sql`select 1 as one`)]).toEqual([{ one: 1 }])
  })
})
