import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { getConfig } from '../config.js'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * Applies pending migrations. A session-level advisory lock keeps two processes that
 * boot together (API and worker) from racing through the journal.
 */
export async function runMigrations(databaseUrl = getConfig().DATABASE_URL) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(hashtext('squirmy:migrations'))`
    try {
      await migrate(drizzle(sql), { migrationsFolder })
    } finally {
      await sql`select pg_advisory_unlock(hashtext('squirmy:migrations'))`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMigrations()
  console.info('Migrations applied')
}
