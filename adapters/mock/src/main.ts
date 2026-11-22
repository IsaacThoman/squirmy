/**
 * Runs the mock provider from the command line. Configuration by environment variables:
 *
 *   PORT                      port to listen on (default 4801)
 *   HOST                      address to listen on (default 0.0.0.0)
 *   MOCK_PROVIDER_SECRET      shared secret (default mock-provider-secret)
 *   MOCK_PROVIDER_COVERAGE    assume_available (default) or must_resolve
 *   MOCK_PROVIDER_DELAY_MS    wait before each delivery
 *   MOCK_PROVIDER_FAIL        1: accept jobs, then fail them
 *   MOCK_PROVIDER_WRONG_FILE  1: deliver a different tone than asked for
 *   MOCK_PROVIDER_PRICED      1: put a price on every offer
 *   MOCK_PROVIDER_VERSION     the version it reports in capabilities
 *   MOCK_PROVIDER_MISSING     a regular expression: tracks and albums whose title matches have no offer
 */
import type { ProviderResolveItem } from '@squirmy/contracts'
import { createMockProvider } from './index.js'

const env = process.env
const flag = (name: string) => env[name] === '1' || env[name] === 'true'
const coverage = env.MOCK_PROVIDER_COVERAGE === 'must_resolve' ? 'must_resolve' : 'assume_available'
const missing = env.MOCK_PROVIDER_MISSING ? new RegExp(env.MOCK_PROVIDER_MISSING, 'i') : null

const provider = createMockProvider({
  ...(env.MOCK_PROVIDER_SECRET ? { secret: env.MOCK_PROVIDER_SECRET } : {}),
  coverage,
  delayMs: Number(env.MOCK_PROVIDER_DELAY_MS ?? 0),
  fail: flag('MOCK_PROVIDER_FAIL'),
  wrongFile: flag('MOCK_PROVIDER_WRONG_FILE'),
  priced: flag('MOCK_PROVIDER_PRICED'),
  ...(env.MOCK_PROVIDER_VERSION ? { version: env.MOCK_PROVIDER_VERSION } : {}),
  ...(missing ? { has: (item: ProviderResolveItem) => !missing.test(item.kind === 'album' ? item.album.title : item.recording.title) } : {}),
})
const url = await provider.listen(Number(env.PORT ?? 4801), env.HOST ?? '0.0.0.0')
console.log(`Mock provider listening on ${url} (${coverage})`)
const stop = () => void provider.close().then(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
