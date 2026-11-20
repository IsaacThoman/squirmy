import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getConfig } from '../config.js'

let development: string | undefined

/**
 * The running version: SQUIRMY_VERSION when it is set (release images pass it as a build
 * argument), else a development marker, worked out once per process.
 */
export function getVersion(): string {
  return getConfig().SQUIRMY_VERSION?.trim() || (development ??= developmentVersion())
}

/**
 * `dev+<short commit>` when the server runs from a git checkout and git is installed,
 * else `dev` (an image built without SQUIRMY_VERSION has neither).
 */
export function developmentVersion(): string {
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
