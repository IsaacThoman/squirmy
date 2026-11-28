import { randomInt } from 'node:crypto'
import { RECOVERY_CODE_COUNT, type TwoFactorSetup, type TwoFactorStatus } from '@squirmy/contracts'
import { and, count, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { recoveryCodes, totpCredentials } from '../../database/schema.js'
import { decrypt, encrypt, sign } from '../../lib/crypto.js'
import { conflict } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { matchTotp, newTotpSecret, otpauthUrl, qrCodeDataUrl } from './totp.js'

const secretPurpose = 'totp-secret'
const recoveryPurpose = 'recovery-code'
/** No 0/o, 1/l/i: recovery codes are often copied from paper. */
const recoveryAlphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
const recoveryLength = 10

export async function twoFactorEnabled(userId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor.select({ userId: totpCredentials.userId }).from(totpCredentials)
    .where(and(eq(totpCredentials.userId, userId), isNotNull(totpCredentials.confirmedAt)))
  return !!row
}

export async function twoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const [row] = await db.select({ confirmedAt: totpCredentials.confirmedAt }).from(totpCredentials).where(eq(totpCredentials.userId, userId))
  const [codes] = await db.select({ count: count() }).from(recoveryCodes).where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
  const enabledAt = row?.confirmedAt ?? null
  return { enabled: !!enabledAt, enabledAt: enabledAt?.toISOString() ?? null, recoveryCodesRemaining: enabledAt ? codes?.count ?? 0 : 0 }
}

/**
 * Starts enrolment with a new secret, replacing an unfinished one. Two-factor stays off until
 * `enableTwoFactor` checks a code made from it.
 */
export async function startTwoFactorSetup(user: { id: string; username: string }, issuer: string): Promise<TwoFactorSetup> {
  const secret = newTotpSecret()
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(totpCredentials).where(eq(totpCredentials.userId, user.id)).for('update')
    if (current?.confirmedAt) throw conflict('Two-factor authentication is already on', 'two_factor_enabled')
    const values = { secretEncrypted: encrypt(secretPurpose, secret), lastStep: 0, confirmedAt: null, createdAt: new Date() }
    await tx.insert(totpCredentials).values({ userId: user.id, ...values })
      .onConflictDoUpdate({ target: totpCredentials.userId, set: values })
  })
  const url = otpauthUrl(secret, issuer, user.username)
  return { secret, otpauthUrl: url, qrCode: qrCodeDataUrl(url) }
}

/**
 * Turns two-factor on when `code` comes from the secret being set up. Resolves to the new
 * recovery codes, or null for a wrong code.
 */
export async function enableTwoFactor(userId: string, code: string): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(totpCredentials).where(eq(totpCredentials.userId, userId)).for('update')
    if (!current) throw conflict('Start setting up two-factor authentication first', 'two_factor_not_started')
    if (current.confirmedAt) throw conflict('Two-factor authentication is already on', 'two_factor_enabled')
    const step = matchTotp(decrypt(secretPurpose, current.secretEncrypted), code)
    if (step === null) return null
    await tx.update(totpCredentials).set({ confirmedAt: new Date(), lastStep: step }).where(eq(totpCredentials.userId, userId))
    return replaceRecoveryCodes(tx, userId)
  })
}

/** Turns two-factor off: the secret and every recovery code go. */
export async function disableTwoFactor(executor: Executor, userId: string) {
  await executor.delete(totpCredentials).where(eq(totpCredentials.userId, userId))
  await executor.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  return db.transaction((tx) => replaceRecoveryCodes(tx, userId))
}

async function replaceRecoveryCodes(executor: Executor, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
  await executor.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
  await executor.insert(recoveryCodes).values(codes.map((code) => ({ id: newId(), userId, codeHash: recoveryHash(userId, code) })))
  return codes
}

function newRecoveryCode(): string {
  let code = ''
  for (let index = 0; index < recoveryLength; index += 1) code += recoveryAlphabet[randomInt(recoveryAlphabet.length)]
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

/** Case, spaces and dashes do not matter: people type these from paper. */
function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Keyed with the server secret, not a bare hash: a copy of the database alone does not let
 * anyone test guesses offline. The user id is part of it, so a code is only ever one user's.
 */
function recoveryHash(userId: string, code: string): string {
  return sign(recoveryPurpose, `${userId}:${normalizeRecoveryCode(code)}`)
}

/**
 * Checks a second factor: six digits against the authenticator secret, anything else as a
 * recovery code. Either is used up by a match, in one statement, so a code seen once (or two
 * requests racing with it) cannot sign in twice. Resolves to what matched, or null.
 */
export async function redeemSecondFactor(userId: string, code: string): Promise<'two_factor' | 'recovery_code' | null> {
  const digits = code.replace(/\s+/g, '')
  if (/^\d{6}$/.test(digits)) {
    const [current] = await db.select().from(totpCredentials)
      .where(and(eq(totpCredentials.userId, userId), isNotNull(totpCredentials.confirmedAt)))
    if (!current) return null
    const step = matchTotp(decrypt(secretPurpose, current.secretEncrypted), digits)
    if (step === null) return null
    const [taken] = await db.update(totpCredentials).set({ lastStep: step })
      .where(and(eq(totpCredentials.userId, userId), lt(totpCredentials.lastStep, step)))
      .returning({ userId: totpCredentials.userId })
    return taken ? 'two_factor' : null
  }
  if (normalizeRecoveryCode(code).length !== recoveryLength) return null
  if (!await twoFactorEnabled(userId)) return null
  const [used] = await db.update(recoveryCodes).set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.codeHash, recoveryHash(userId, code)), eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id })
  return used ? 'recovery_code' : null
}
