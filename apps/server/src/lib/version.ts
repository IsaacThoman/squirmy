import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getConfig } from '../config.js'

let development: string | undefined

const commitPattern = /^[0-9a-f]{7,40}$/i

/**
 * The running version: SQUIRMY_VERSION when it is set (release images pass it as a build
 * argument), else a development marker, worked out once per process.
 */
export function getVersion(): string {
  return getConfig().SQUIRMY_VERSION?.trim() || (development ??= developmentVersion())
}

/**
 * `dev+<short commit>` from SOURCE_COMMIT (a build argument of the image, or set at run time
 * by a platform such as Coolify), else from git when the server runs from a checkout, else
 * `dev` (an image built without either argument has neither).
 */
export function developmentVersion(): string {
  const source = getConfig().SOURCE_COMMIT?.trim()
  if (source && commitPattern.test(source)) return `dev+${source.slice(0, 7).toLowerCase()}`
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    return /^[0-9a-f]{4,40}$/.test(commit) ? `dev+${commit}` : 'dev'
  } catch {
    return 'dev'
  }
}
