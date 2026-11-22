import { z } from 'zod'
import { parseTrustProxy } from './lib/proxy.js'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4747),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
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
  /** Comma separated paths added as read-only library roots on first boot. */
  SQUIRMY_LIBRARY_PATHS: z.string().optional(),
  /** Comma separated paths added as managed library roots (organized by the server) on first boot. */
  SQUIRMY_MANAGED_LIBRARY_PATHS: z.string().optional(),
  /** Folder watched for music to import, used while the `inboxPath` server setting is unset. */
  SQUIRMY_INBOX_PATH: z.string().optional(),
  /**
   * Public origin, e.g. https://music.example.com. Used for absolute links, and an https
   * origin marks the session cookie Secure for requests to its host.
   */
  PUBLIC_URL: z.literal('').transform(() => undefined).or(z.string().url()).optional(),
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
})

export type Config = z.infer<typeof Env>

/** Origins of the Vite dev server, the only cross-origin callers allowed outside production. */
export const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']

let cached: Config | undefined

export function getConfig(): Config {
  cached ??= Env.parse(process.env)
  return cached
}

/** Tests change the environment between files; this makes the next getConfig() re-read it. */
export function resetConfig() {
  cached = undefined
}
