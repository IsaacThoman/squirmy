import { readFileSync } from 'node:fs'
import { getConfig } from '../config.js'

let packageVersion: string | undefined

/** The running version: SQUIRMY_VERSION, else the repository's root package.json. */
export function getVersion(): string {
  const fromEnv = getConfig().SQUIRMY_VERSION
  if (fromEnv) return fromEnv
  if (packageVersion === undefined) {
    try {
      // The same depth from src/lib and dist/lib.
      const file = new URL('../../../../package.json', import.meta.url)
      packageVersion = (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0'
    } catch {
      packageVersion = '0.0.0'
    }
  }
  return packageVersion
}
