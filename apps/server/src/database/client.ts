import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getConfig } from '../config.js'
import { closeLocks } from './locks.js'
import * as schema from './schema.js'

export type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Either the database or an open transaction. Service functions take this. */
export type Executor = Database | Transaction

let client: postgres.Sql | undefined
let database: Database | undefined
let sealed = false

/**
 * Connections in the query pool: SQUIRMY_DB_POOL_SIZE, else 10, or 4 under test so tests
 * find work that needs more connections than it may assume. Nothing may hold a pooled
 * connection while it waits for other work that needs one: a lock that outlives a
 * statement belongs on the lock connection (locks.ts), and a transaction only runs its own
 * statements, never a network call, another job or a query on `db`.
 */
export function poolSize(): number {
  const config = getConfig()
  return config.SQUIRMY_DB_POOL_SIZE ?? (config.NODE_ENV === 'test' ? 4 : 10)
}

/** The postgres.js client, created on first use from DATABASE_URL. */
export function getSql(): postgres.Sql {
  if (sealed) throw new Error('The database is closed')
  if (!client) {
    const config = getConfig()
    client = postgres(config.DATABASE_URL, {
      max: poolSize(),
      prepare: false,
      onnotice: () => {},
    })
  }
  return client
}

export function getDb(): Database {
  database ??= drizzle(getSql(), { schema })
  return database
}

function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = resolve()
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * The Drizzle database. It connects on first use rather than at import, so tests can
 * point DATABASE_URL at their own database before anything runs.
 */
export const db: Database = lazy(getDb)

/**
 * Closes the pool and the lock connection. The next use reconnects with the current DATABASE_URL, unless `final`
 * is set: then every use throws until the next close without it. A test database closes
 * finally before it is dropped, so work that outlives it (a timer, a socket handler)
 * fails like any query instead of opening a pool to a database that is being dropped.
 */
export async function closeDb({ final = false }: { final?: boolean } = {}) {
  sealed = final
  const current = client
  client = undefined
  database = undefined
  await Promise.all([current?.end({ timeout: 5 }), closeLocks({ final })])
}

export { schema }
