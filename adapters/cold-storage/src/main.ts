/**
 * Runs the cold-storage provider. Configuration by environment variables:
 *
 *   COLD_STORAGE_DIR              folder of audio files (required)
 *   COLD_STORAGE_SECRET           shared secret, at least 8 characters (required)
 *   COLD_STORAGE_NAME             name shown in the server (default "Cold storage")
 *   COLD_STORAGE_RESCAN_MINUTES   how often to look for new files (default 60, 0 to never)
 *   COLD_STORAGE_MAX_CONCURRENT   deliveries at once (default 2)
 *   PORT                          port to listen on (default 4800)
 *   HOST                          address to listen on (default 0.0.0.0)
 */
import { createColdStorage } from './index.js'

const env = process.env
const folder = env.COLD_STORAGE_DIR
const secret = env.COLD_STORAGE_SECRET
if (!folder || !secret || secret.length < 8) {
  console.error('Set COLD_STORAGE_DIR and COLD_STORAGE_SECRET (at least 8 characters).')
  process.exit(1)
}

const provider = createColdStorage({
  folder,
  secret,
  name: env.COLD_STORAGE_NAME,
  maxConcurrent: env.COLD_STORAGE_MAX_CONCURRENT ? Number(env.COLD_STORAGE_MAX_CONCURRENT) : undefined,
})
const started = Date.now()
const { files } = await provider.index.scan()
console.log(`Indexed ${files} files in ${folder} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
const url = await provider.listen(Number(env.PORT ?? 4800), env.HOST ?? '0.0.0.0')
console.log(`Cold storage listening on ${url}`)

const minutes = Number(env.COLD_STORAGE_RESCAN_MINUTES ?? 60)
let scanning = false
const timer = minutes > 0 ? setInterval(() => {
  if (scanning) return
  scanning = true
  provider.index.scan()
    .then(({ files, read }) => read > 0 && console.log(`Rescanned: ${files} files, ${read} read`))
    .catch((error: unknown) => console.error('Rescan failed', error))
    .finally(() => { scanning = false })
}, minutes * 60_000) : null

const stop = () => {
  if (timer) clearInterval(timer)
  void provider.close().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
