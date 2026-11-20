/**
 * Subsonic authentication. Every request carries its credentials, and the credential is
 * always an app password from Squirmy's settings, never the account password:
 *
 * - `apiKey` (the apiKeyAuthentication extension): the app password itself, with no `u`;
 * - `u` + `t` + `s`: token auth, `t = md5(app password + s)`;
 * - `u` + `p`: the app password in clear or as `enc:` hex.
 *
 * Comparisons are constant time (auth/service.ts). Failures are counted per IP; an IP
 * over the limit is refused without checking until its window ends.
 */
import type { AuthUser } from '../../lib/auth.js'
import { findAppPasswordByKey, verifyAppPassword } from '../auth/service.js'
import { ErrorCode, missingParameter, SubsonicError, type Params } from './protocol.js'

const FAILURE_LIMIT = 10
const FAILURE_WINDOW_MS = 60_000

const failures = new Map<string, { count: number; resetAt: number }>()

function limited(ip: string, now: number): boolean {
  const entry = failures.get(ip)
  return entry !== undefined && entry.resetAt > now && entry.count >= FAILURE_LIMIT
}

function recordFailure(ip: string, now: number) {
  if (failures.size > 10_000) {
    for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key)
  }
  const entry = failures.get(ip)
  if (!entry || entry.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
  else entry.count += 1
}

/** Forgets every failure count. For tests. */
export function resetAuthFailures() {
  failures.clear()
}

function decodePassword(raw: string): string {
  if (!raw.startsWith('enc:')) return raw
  const hex = raw.slice(4)
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new SubsonicError(ErrorCode.wrongCredentials, 'Wrong username or password')
  return Buffer.from(hex, 'hex').toString('utf8')
}

async function check(params: Params): Promise<AuthUser> {
  const apiKey = params.string('apiKey')
  const username = params.string('u')
  const password = params.string('p')
  const token = params.string('t')
  const salt = params.string('s')

  if (apiKey !== undefined) {
    if (username !== undefined || password !== undefined || token !== undefined || salt !== undefined) {
      throw new SubsonicError(ErrorCode.conflictingAuth, 'Multiple conflicting authentication mechanisms provided')
    }
    const user = apiKey ? await findAppPasswordByKey(apiKey) : null
    if (!user) throw new SubsonicError(ErrorCode.invalidApiKey, 'Invalid API key')
    return user
  }
  if (!username) throw missingParameter('u')
  if (password !== undefined && (token !== undefined || salt !== undefined)) {
    throw new SubsonicError(ErrorCode.conflictingAuth, 'Multiple conflicting authentication mechanisms provided')
  }
  let user: AuthUser | null
  if (token !== undefined || salt !== undefined) {
    if (!token) throw missingParameter('t')
    if (!salt) throw missingParameter('s')
    user = await verifyAppPassword(username, { token, salt })
  } else {
    if (!password) throw missingParameter('p')
    user = await verifyAppPassword(username, { password: decodePassword(password) })
  }
  if (!user) throw new SubsonicError(ErrorCode.wrongCredentials, 'Wrong username or password')
  return user
}

/** The user the request's credentials belong to. Throws a SubsonicError with code 10, 40, 43 or 44. */
export async function authenticate(params: Params, ip: string): Promise<AuthUser> {
  const now = Date.now()
  if (limited(ip, now)) throw new SubsonicError(ErrorCode.wrongCredentials, 'Too many failed attempts; try again in a minute')
  try {
    return await check(params)
  } catch (error) {
    if (error instanceof SubsonicError && error.code !== ErrorCode.missingParameter) recordFailure(ip, now)
    throw error
  }
}
