import { buildApp } from './app.js'
import { getConfig } from './config.js'
import { closeDb } from './database/client.js'
import { runMigrations } from './database/migrate.js'

const config = getConfig()
await runMigrations()

const app = await buildApp()

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Stopping')
  const deadline = setTimeout(() => process.exit(1), 20_000)
  deadline.unref()
  await app.close()
  await closeDb()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: config.HOST, port: config.PORT })
