import { z } from 'zod'
import { parseTrustProxy } from './lib/proxy.js'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4747),
  // The same message whether the variable is missing or empty; troubleshooting.md quotes it.
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  /** Artwork, transcodes, staging and the generated secret live here. `art/`, `transcodes/` and most of `assets/` are rebuilt on their own. */
  SQUIRMY_DATA_DIR: z.string().default('./data'),
  /**
   * Root secret for signing URLs and encrypting stored credentials. When unset, one is
   * generated on first boot and kept in the data directory.
   */
  SQUIRMY_SECRET: z.string().min(16).optional(),
  /** all: API and worker in one process. api / worker: split them for bigger installs. */
  SQUIRMY_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** Built web app to serve. Empty disables static serving (the Vite dev server proxies instead). */
  SQUIRMY_WEB_DIST: z.string().optional(),
  /** Publish the direct HTTP port to Apple TVs on the local network via Bonjour. */
  SQUIRMY_LAN_DISCOVERY: z.enum(['true', 'false', '1', '0', '']).optional().transform(value => value === 'true' || value === '1'),
  /** Comma separated paths added as read-only library roots at start, unless a root already has the path. */
  SQUIRMY_LIBRARY_PATHS: z.string().optional(),
  /** Comma separated paths added as managed library roots (organized by the server) at start, unless a root already has the path. */
  SQUIRMY_MANAGED_LIBRARY_PATHS: z.string().optional(),
  /** Folder watched for music to import, used while the `inboxPath` server setting is unset. */
  SQUIRMY_INBOX_PATH: z.string().optional(),
  /**
   * Public origin, e.g. https://music.example.com, for absolute links and the delivery
   * addresses given to acquisition providers; an https origin also marks the session cookie
   * Secure for requests to its host. Empty counts as unset, because compose.yaml passes it
   * through as `${PUBLIC_URL:-}`.
   */
  PUBLIC_URL: z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional()),
  /**
   * Which proxies may report the client's address and protocol: `false`; `true` for one
   * proxy on this machine or a private network; a number of proxies; or a comma separated
   * list of addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`, `private`.
   * See docs/server/reverse-proxy.md.
   */
  TRUST_PROXY: z.string().default('false').transform((value, context) => {
    try {
      return parseTrustProxy(value)
    } catch (error) {
      context.addIssue({ code: 'custom', message: `TRUST_PROXY: ${(error as Error).message}` })
      return z.NEVER
    }
  }),
  /**
   * A header the outermost proxy sets to the client's address, such as CF-Connecting-IP
   * behind Cloudflare. Read only from a peer TRUST_PROXY trusts.
   */
  CLIENT_IP_HEADER: z.string().trim().toLowerCase().regex(/^[a-z0-9-]*$/, 'CLIENT_IP_HEADER must be a header name')
    .transform((value) => value || undefined).optional(),
  /**
   * Recovery for a server whose admins can no longer sign in with single sign-on: while set,
   * admins (only) may sign in with their password even when password sign-in is off.
   */
  SQUIRMY_ADMIN_PASSWORD_LOGIN: z.enum(['true', 'false', '1', '0', '']).optional().transform((value) => value === 'true' || value === '1'),
  /** Connections in the database query pool of each process. Default 10, 4 under test. */
  SQUIRMY_DB_POOL_SIZE: z.coerce.number().int().min(2).max(200).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FPCALC_PATH: z.string().default('fpcalc'),
  /** Memory for cached reads (Home, library lists, pages) in the API process; 0 turns the cache off. Default 64, 0 under test. */
  SQUIRMY_READ_CACHE_MB: z.coerce.number().min(0).max(4096).optional(),
  /** Set by release builds; otherwise the version is dev, with the git commit when there is one. */
  SQUIRMY_VERSION: z.string().optional(),
  /** The commit an image was built from (build argument, or set at run time by Coolify). Without SQUIRMY_VERSION the version is dev+<its first 7 characters>. */
  SOURCE_COMMIT: z.string().optional(),
}).superRefine((env, context) => {
  // Ignored silently, everyone would share the proxy's address and its limits.
  if (env.CLIENT_IP_HEADER && env.TRUST_PROXY.kind === 'none') {
    context.addIssue({ code: 'custom', path: ['CLIENT_IP_HEADER'], message: 'CLIENT_IP_HEADER needs TRUST_PROXY to trust the proxy that sets it' })
  }
})

export type Config = z.infer<typeof Env> & {
  /**
   * Whether the Vite dev server's origins may call with credentials. Only when NODE_ENV is
   * set to development, not when it is merely unset: a bare-metal install that forgot
   * NODE_ENV must not trust whatever runs on localhost:5173 of a visitor's machine.
   */
  devCors: boolean
}

/** Origins of the Vite dev server, the only cross-origin callers allowed in development. */
export const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']

let cached: Config | undefined

export function getConfig(): Config {
  cached ??= { ...Env.parse(process.env), devCors: process.env.NODE_ENV === 'development' }
  return cached
}

/** Tests change the environment between files; this makes the next getConfig() re-read it. */
export function resetConfig() {
  cached = undefined
}
