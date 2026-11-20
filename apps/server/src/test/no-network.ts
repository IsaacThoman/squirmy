/**
 * Runs before every test file. Tests must not depend on the outside world, so any
 * request that leaves this machine fails loudly; `useHttpFixtures` supplies recorded
 * responses instead. Recording mode needs the real network and skips the guard.
 */
const realFetch = globalThis.fetch
const local = new Set(['localhost', '127.0.0.1', '[::1]'])

if (process.env.SQUIRMY_RECORD_HTTP !== '1') {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (local.has(url.hostname)) return realFetch(input, init)
    throw new Error(`Tests must not use the network (${url.origin}). Serve the response with useHttpFixtures().`)
  }) as typeof fetch
}
