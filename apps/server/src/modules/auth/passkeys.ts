import { PASSKEY_LIMIT, type Passkey } from '@squirmy/contracts'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { and, asc, count, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, type Executor } from '../../database/client.js'
import { passkeys, users } from '../../database/schema.js'
import type { AuthUser } from '../../lib/auth.js'
import { conflict } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'

/**
 * The relying party passkeys belong to: PUBLIC_URL's host name and origin. Browsers offer
 * WebAuthn only in a secure context, so it must be https, or localhost while developing. A
 * passkey is bound to the host name it was made on: moving the server to another name means
 * making new ones.
 */
export function relyingParty(): { id: string; origin: string } | null {
  const publicUrl = getConfig().PUBLIC_URL
  if (!publicUrl) return null
  const url = new URL(publicUrl)
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()
  const local = hostname === 'localhost' || hostname.endsWith('.localhost')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  // An IP address cannot be a relying party ID.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return null
  return { id: hostname, origin: url.origin }
}

/**
 * WebAuthn's user handle: the user's id as 16 bytes. It names no one, and the same handle on
 * every passkey of an account lets an authenticator replace an old one rather than keep two.
 */
export function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex'))
}

function toPasskey(row: typeof passkeys.$inferSelect): Passkey {
  return {
    id: row.id,
    name: row.name,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }
}

export async function listPasskeys(userId: string): Promise<Passkey[]> {
  const rows = await db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(asc(passkeys.createdAt))
  return rows.map(toPasskey)
}

export async function registrationOptions(user: AuthUser, rp: { id: string }, serverName: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await db.select({ credentialId: passkeys.credentialId, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.userId, user.id))
  if (existing.length >= PASSKEY_LIMIT) throw conflict(`An account can have at most ${PASSKEY_LIMIT} passkeys. Remove one you no longer use.`, 'too_many_passkeys')
  return generateRegistrationOptions({
    rpName: serverName,
    rpID: rp.id,
    userName: user.username,
    userDisplayName: user.displayName ?? user.username,
    userID: userHandle(user.id),
    attestationType: 'none',
    // The same authenticator is not registered twice.
    excludeCredentials: existing.map((row) => ({ id: row.credentialId, transports: row.transports })),
    // Discoverable, so sign-in needs no username; verified (PIN, biometrics), so a passkey
    // stands in for the password and a second factor together.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
}

export async function registerPasskey(input: {
  userId: string
  name: string
  expectedChallenge: string
  response: RegistrationResponseJSON
  rp: { id: string; origin: string }
}): Promise<Passkey | null> {
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.id,
    requireUserVerification: true,
  }).catch(() => null)
  if (!verification?.verified) return null
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update')
    const [held] = await tx.select({ count: count() }).from(passkeys).where(eq(passkeys.userId, input.userId))
    if ((held?.count ?? 0) >= PASSKEY_LIMIT) throw conflict(`An account can have at most ${PASSKEY_LIMIT} passkeys. Remove one you no longer use.`, 'too_many_passkeys')
    const [taken] = await tx.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, credential.id))
    if (taken) throw conflict('That passkey is already added', 'passkey_exists')
    const [row] = await tx.insert(passkeys).values({
      id: newId(),
      userId: input.userId,
      name: input.name,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    }).returning()
    return toPasskey(row!)
  })
}

export async function renamePasskey(userId: string, id: string, name: string): Promise<Passkey | null> {
  const [row] = await db.update(passkeys).set({ name }).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning()
  return row ? toPasskey(row) : null
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const deleted = await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).returning({ id: passkeys.id })
  return deleted.length > 0
}

/** Deletes every passkey of a user, when an admin resets their password or disables them. */
export async function revokePasskeys(executor: Executor, userId: string) {
  await executor.delete(passkeys).where(eq(passkeys.userId, userId))
}

/** Options for signing in with any passkey of this server: none are listed, the browser offers its own. */
export function authenticationOptions(rp: { id: string }): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' })
}

/**
 * Checks a passkey sign-in. Resolves to the account, or null for anything that does not verify:
 * an unknown credential, a wrong signature, a user handle of another account, no user
 * verification, or a signature counter that went backwards (a cloned authenticator).
 */
export async function verifyPasskeySignIn(input: {
  expectedChallenge: string
  response: AuthenticationResponseJSON
  rp: { id: string; origin: string }
}): Promise<(typeof users.$inferSelect) | null> {
  const [found] = await db.select({ passkey: passkeys, user: users }).from(passkeys)
    .innerJoin(users, eq(users.id, passkeys.userId))
    .where(eq(passkeys.credentialId, input.response.id))
  if (!found) return null
  const { passkey, user } = found
  const handle = input.response.response.userHandle
  if (handle !== undefined && handle !== Buffer.from(userHandle(user.id)).toString('base64url')) return null
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.rp.origin,
    expectedRPID: input.rp.id,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
      counter: passkey.counter,
      transports: passkey.transports,
    },
  }).catch(() => null)
  if (!verification?.verified) return null
  await db.update(passkeys).set({
    counter: verification.authenticationInfo.newCounter,
    backedUp: verification.authenticationInfo.credentialBackedUp,
    lastUsedAt: new Date(),
  }).where(eq(passkeys.id, passkey.id))
  return user
}
