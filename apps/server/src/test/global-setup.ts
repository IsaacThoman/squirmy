import postgres from 'postgres'
import { runMigrations } from '../database/migrate.js'

/**
 * Builds one migrated template database per test run. Each test file then clones it,
 * which takes milliseconds, instead of replaying every migration.
 *
 * SQUIRMY_TEST_DATABASE_URL must point at a Postgres server the tests may create
 * databases on, e.g. postgres://localhost:54329/postgres.
 */
export const adminUrl = () => process.env.SQUIRMY_TEST_DATABASE_URL ?? 'postgres://localhost:54329/postgres'

export function databaseUrl(name: string) {
  const url = new URL(adminUrl())
  url.pathname = `/${name}`
  return url.toString()
}

export default async function setup() {
  const template = `squirmy_template_${process.pid}_${Date.now()}`
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database "${template}"`)
  } catch (error) {
    await admin.end()
    throw new Error(`Database tests need a Postgres server at ${adminUrl()} (set SQUIRMY_TEST_DATABASE_URL).`, { cause: error })
  }
  await admin.end()
  await runMigrations(databaseUrl(template))
  process.env.SQUIRMY_TEST_TEMPLATE = template

  return async () => {
    const cleanup = postgres(adminUrl(), { max: 1, onnotice: () => {} })
    await cleanup.unsafe(`drop database if exists "${template}" with (force)`)
    await cleanup.end()
  }
}
