/**
 * Subsonic authentication. Every request carries its credentials, and the credential is
 * always an app password from Squirmy's settings, never the account password:
 *
 * - `apiKey` (the apiKeyAuthentication extension): the app password itself, with no `u`;
 * - `u` + `t` + `s`: token auth, `t = md5(app password + s)`;
 * - `u` + `p`: the app password in clear or as `enc:` hex.
 *
 * Comparisons are constant time (auth/service.ts). There is no lockout: app passwords are
 * 144-bit random, so guessing them is hopeless, and checking them is cheap (no argon2). A
 * lockout per address only let anyone sharing the address, or claiming it, cut off every
 * app there.
 */
import type { AuthUser } from '../../lib/auth.js'
import { findAppPasswordByKey, verifyAppPassword } from '../auth/service.js'
import { ErrorCode, missingParameter, SubsonicError, type Params } from './protocol.js'

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
export async function authenticate(params: Params): Promise<AuthUser> {
  return check(params)
}
