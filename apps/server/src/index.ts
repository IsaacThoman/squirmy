import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { getConfig } from './config.js'
import { closeDb } from './database/client.js'
import { runMigrations } from './database/migrate.js'
import { jobs, startJobs, stopJobs } from './jobs/index.js'
import { getVersion } from './lib/version.js'
import { modules } from './modules/index.js'
import { startRealtime } from './realtime/index.js'

const config = getConfig()
const role = config.SQUIRMY_ROLE
const serveApi = role !== 'worker'
const runWorker = role !== 'api'
// Worked out now, so no request waits for it.
const version = getVersion()

// Every step registers its undo here, so a failed boot and a signal unwind the same way.
const undo: (() => Promise<void>)[] = []
let app: FastifyInstance | undefined

async function stopAll() {
  for (const step of undo.reverse()) {
    try {
      await step()
    } catch (error) {
      console.error('[shutdown]', error)
    }
  }
  undo.length = 0
}

let stopping = false
async function shutdown(signal: string, code = 0) {
  if (stopping) return
  stopping = true
  console.info(`[squirmy] stopping (${signal})`)
  // Inside the 30 second stop grace period compose.yaml sets and Coolify uses by default,
  // so this, not a SIGKILL, ends a shutdown that hangs. Module stops run first: a search
  // index import checkpoints within its first seconds (catalog-index/index.ts).
  const deadline = setTimeout(() => process.exit(1), 20_000)
  deadline.unref()
  await stopAll()
  process.exit(code)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  undo.push(closeDb)
  // Inside the try, so a failed migration is logged as a failed start and closes the pool.
  await runMigrations()

  if (runWorker) for (const module of modules) await module.jobs?.(jobs)
  await startJobs({ work: runWorker })
  undo.push(stopJobs)

  if (serveApi) {
    const server = await buildApp()
    app = server
    undo.push(() => server.close())
    const realtime = await startRealtime(server)
    for (const module of modules) await module.realtime?.(realtime)
  }

  for (const module of modules) {
    await module.start?.({ role })
    const { stop } = module
    if (stop) undo.push(async () => stop())
  }

  if (app) await app.listen({ host: config.HOST, port: config.PORT })
  console.info(`[squirmy] ${version} running as ${role}`)
} catch (error) {
  console.error('[squirmy] failed to start', error)
  await shutdown('startup failure', 1)
}
