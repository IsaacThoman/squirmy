import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { getConfig } from '../config.js'
import * as schema from './schema.js'

export type Database = PostgresJsDatabase<typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Either the database or an open transaction. Service functions take this. */
export type Executor = Database | Transaction

let client: postgres.Sql | undefined
let database: Database | undefined

/** The postgres.js client, created on first use from DATABASE_URL. */
export function getSql(): postgres.Sql {
  if (!client) {
    const config = getConfig()
    client = postgres(config.DATABASE_URL, {
      max: config.NODE_ENV === 'test' ? 4 : 10,
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

/** Closes the pool. The next use reconnects with the current DATABASE_URL. */
export async function closeDb() {
  const current = client
  client = undefined
  database = undefined
  await current?.end({ timeout: 5 })
}

export { schema }
