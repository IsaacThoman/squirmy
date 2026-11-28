import { createHash, timingSafeEqual } from 'node:crypto'
import { APP_PASSWORD_LIMIT, type AppPassword, type ClientDevice, type User } from '@squirmy/contracts'
import argon2 from 'argon2'
import { and, count, desc, eq, getTableColumns, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { appPasswords, authSessions, devices, users } from '../../database/schema.js'
import type { AuthUser } from '../../lib/auth.js'
import { AppError, conflict } from '../../lib/errors.js'
import { decrypt, encrypt, hashToken, randomToken } from '../../lib/crypto.js'
import { newId } from '../../lib/ids.js'

const sessionLifetimeMs = 180 * 24 * 60 * 60 * 1000
/** Devices kept per user; clients choose their ids, so the least recently seen go first. */
const deviceLimit = 100
const lastSeenIntervalMs = 60 * 1000

const { passwordHash: _passwordHash, ...userColumns } = getTableColumns(users)

export function usernameKey(username: string) {
  return username.trim().toLowerCase()
}

/**
 * Whether explicit songs play for the user: their own `allowExplicit` setting, unless an admin
 * restricted it. `catalog/explicit.ts` applies the same rule in SQL (`explicitAllowed`).
 */
function allowsExplicit(row: Pick<AuthUser, 'explicitRestricted' | 'settings'>): boolean {
  return !row.explicitRestricted && row.settings.allowExplicit !== false
}

export function toUser(row: AuthUser): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    canUpload: row.canUpload,
    canAcquire: row.canAcquire,
    createdAt: row.createdAt.toISOString(),
    disabled: row.disabledAt !== null,
    explicitRestricted: row.explicitRestricted,
    allowsExplicit: allowsExplicit(row),
  }
}

/**
 * Each argon2 run takes 64 MiB and one of libuv's four threads, which also serve file
 * reads for streaming and artwork. At most two run at once and a bounded number wait, so
 * a flood of sign-ins slows sign-ins rather than playback for everyone.
 */
const hashSlots = 2
const hashQueueLimit = 64
let hashing = 0
const waiting: (() => void)[] = []

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (hashing < hashSlots) hashing += 1
  else if (waiting.length >= hashQueueLimit) throw new AppError(503, 'busy', 'The server is busy. Try again in a moment.')
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await work()
  } finally {
    // A waiter takes over this slot; otherwise it is free again.
    const next = waiting.shift()
    if (next) next()
    else hashing -= 1
  }
}

export function hashPassword(password: string) {
  return withHashSlot(() => argon2.hash(password, { type: argon2.argon2id }))
}

let dummyHash: Promise<string> | undefined

/**
 * Checks a username and password. An unknown username still costs one argon2 verification,
 * so response time does not reveal which usernames exist.
 */
export async function verifyCredentials(username: string, password: string): Promise<(AuthUser & { passwordHash: string }) | null> {
  const [row] = await db.select().from(users).where(eq(users.usernameKey, usernameKey(username)))
  dummyHash ??= hashPassword(randomToken()).catch((error: unknown) => {
    dummyHash = undefined
    throw error
  })
  const hash = row?.passwordHash ?? await dummyHash
  const valid = await withHashSlot(() => argon2.verify(hash, password)).catch((error: unknown) => {
    if (error instanceof AppError) throw error
    return false
  })
  return row && valid ? row : null
}

export type NewSession = { token: string; sessionId: string }

/** Opens a session. Only the token's hash is stored; the token goes back to the client once. */
export async function createSession(executor: Executor, input: {
  userId: string
  device?: ClientDevice
  clientKind: string
  userAgent?: string
}): Promise<NewSession> {
  const token = randomToken()
  const sessionId = newId()
  await executor.insert(authSessions).values({
    id: sessionId,
    userId: input.userId,
    tokenHash: hashToken(token),
    deviceId: input.device?.id,
    clientKind: input.clientKind,
    userAgent: input.userAgent?.slice(0, 500),
    expiresAt: new Date(Date.now() + sessionLifetimeMs),
  })
  if (input.device) await rememberDevice(executor, input.userId, input.device)
  return { token, sessionId }
}

/**
 * Records a device as seen. A new device also prunes the user's list: devices not seen
 * for as long as a session lasts (none of their sign-ins can still be valid, so they only
 * come back by signing in again, which records them anew), then all but the `deviceLimit`
 * most recently seen.
 */
export async function rememberDevice(executor: Executor, userId: string, device: ClientDevice) {
  const { id, name, kind } = device
  const [row] = await executor.insert(devices).values({ userId, id, name, kind })
    .onConflictDoUpdate({ target: [devices.userId, devices.id], set: { name, kind, lastSeenAt: new Date() } })
    .returning({ inserted: sql<boolean>`xmax = 0` })
  if (!row?.inserted) return
  await executor.execute(sql`
    delete from ${devices} where ${devices.userId} = ${userId} and (${devices.lastSeenAt} < now() - ${`${sessionLifetimeMs} milliseconds`}::interval or ${devices.id} not in (
      select ${devices.id} from ${devices} where ${devices.userId} = ${userId}
      order by ${devices.lastSeenAt} desc limit ${deviceLimit}))`)
}

/** The device a sign-in was made from, when it named one. */
export async function sessionDevice(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ deviceId: authSessions.deviceId }).from(authSessions).where(eq(authSessions.id, sessionId))
  return row?.deviceId ?? null
}

/**
 * Resolves a session token. Sessions slide: each use pushes the expiry out again, written
 * at most once a minute.
 */
export async function authenticateToken(token: string): Promise<{ user: AuthUser; sessionId: string; expiresAt: Date } | null> {
  const now = new Date()
  const [row] = await db
    .select({ user: userColumns, sessionId: authSessions.id, lastSeenAt: authSessions.lastSeenAt, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, now)))
  if (!row || row.user.disabledAt) return null
  let expiresAt = row.expiresAt
  if (now.getTime() - row.lastSeenAt.getTime() > lastSeenIntervalMs) {
    expiresAt = new Date(now.getTime() + sessionLifetimeMs)
    await db.update(authSessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(authSessions.id, row.sessionId))
  }
  return { user: row.user, sessionId: row.sessionId, expiresAt }
}

export async function revokeSession(sessionId: string) {
  await db.delete(authSessions).where(eq(authSessions.id, sessionId))
}

/** Ends every session of a user, or every one but `except`. */
export async function revokeUserSessions(executor: Executor, userId: string, except?: string) {
  await executor.delete(authSessions)
    .where(except ? and(eq(authSessions.userId, userId), ne(authSessions.id, except)) : eq(authSessions.userId, userId))
}

// ---------------------------------------------------------------------------
// App passwords: generated secrets for Subsonic clients
// ---------------------------------------------------------------------------

const appPasswordPurpose = 'app-password'

type TokenOptions = { scopes?: import('@squirmy/contracts').ApiTokenScope[]; expiresAt?: Date }

function toAppPassword(row: typeof appPasswords.$inferSelect, secret?: string): AppPassword {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    ...(secret !== undefined && { secret }),
    ...(row.scopes && { scopes: row.scopes }),
    ...(row.expiresAt && { expiresAt: row.expiresAt.toISOString() }),
  }
}

export async function listAppPasswords(userId: string): Promise<AppPassword[]> {
  const rows = await db.select().from(appPasswords).where(eq(appPasswords.userId, userId)).orderBy(desc(appPasswords.createdAt))
  return rows.map((row) => toAppPassword(row))
}

/** Creates an app password. The response is the only time the secret is shown. */
export async function createAppPassword(userId: string, name: string, options: TokenOptions = {}): Promise<AppPassword> {
  const secret = options.scopes ? `sq_${randomToken(32)}` : randomToken(18)
  return db.transaction(async (tx) => {
    // Subsonic auth decrypts every app password of the user on each request; bound them.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update')
    const [held] = await tx.select({ count: count() }).from(appPasswords).where(eq(appPasswords.userId, userId))
    if ((held?.count ?? 0) >= APP_PASSWORD_LIMIT) {
      throw conflict(`An account can have at most ${APP_PASSWORD_LIMIT} app passwords. Delete one you no longer use.`, 'too_many_app_passwords')
    }
    const [row] = await tx.insert(appPasswords).values({
      id: newId(),
      userId,
      name,
      scopes: options.scopes ? [...new Set(options.scopes)] : null,
      expiresAt: options.expiresAt,
      secretEncrypted: options.scopes ? '' : encrypt(appPasswordPurpose, secret),
      keyHash: hashToken(secret),
    }).returning()
    return toAppPassword(row!, secret)
  })
}

/** Deletes every app password of a user, for password resets and lost devices. */
export async function revokeAppPasswords(executor: Executor, userId: string) {
  await executor.delete(appPasswords).where(eq(appPasswords.userId, userId))
}

export async function deleteAppPassword(userId: string, id: string): Promise<boolean> {
  const deleted = await db.delete(appPasswords)
    .where(and(eq(appPasswords.id, id), eq(appPasswords.userId, userId)))
    .returning({ id: appPasswords.id })
  return deleted.length > 0
}

/** Subsonic clients authenticate every request, cover art included, so this writes at most once a minute. */
async function touchAppPassword(id: string) {
  const now = new Date()
  await db.update(appPasswords).set({ lastUsedAt: now }).where(and(
    eq(appPasswords.id, id),
    or(isNull(appPasswords.lastUsedAt), lt(appPasswords.lastUsedAt, new Date(now.getTime() - lastSeenIntervalMs))),
  ))
}

/** OpenSubsonic `apiKey` auth: the key is an app password's secret. */
export async function findAppPasswordByKey(apiKey: string): Promise<AuthUser | null> {
  const [row] = await db.select({ user: userColumns, id: appPasswords.id })
    .from(appPasswords)
    .innerJoin(users, eq(users.id, appPasswords.userId))
    .where(and(eq(appPasswords.keyHash, hashToken(apiKey)), isNull(appPasswords.scopes), validExpiry()))
  if (!row || row.user.disabledAt) return null
  await touchAppPassword(row.id)
  return row.user
}

function validExpiry() {
  return or(isNull(appPasswords.expiresAt), gt(appPasswords.expiresAt, new Date()))
}

export async function authenticateApiToken(token: string) {
  if (!/^sq_[A-Za-z0-9_-]{43}$/.test(token)) return null
  const [row] = await db.select({ user: userColumns, id: appPasswords.id, scopes: appPasswords.scopes })
    .from(appPasswords)
    .innerJoin(users, eq(users.id, appPasswords.userId))
    .where(and(eq(appPasswords.keyHash, hashToken(token)), validExpiry()))
  if (!row?.scopes || row.user.disabledAt) return null
  await touchAppPassword(row.id)
  return { user: row.user, scopes: row.scopes }
}

const md5 = (value: string) => createHash('md5').update(value).digest('hex')

function sameText(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Classic Subsonic auth against the user's app passwords: either the password itself
 * (`p`, already hex-decoded) or the token `t = md5(password + s)`.
 */
export async function verifyAppPassword(
  username: string,
  credential: { password: string } | { token: string; salt: string },
): Promise<AuthUser | null> {
  const rows = await db.select({ user: userColumns, id: appPasswords.id, secretEncrypted: appPasswords.secretEncrypted })
    .from(appPasswords)
    .innerJoin(users, eq(users.id, appPasswords.userId))
    .where(and(eq(users.usernameKey, usernameKey(username)), isNull(appPasswords.scopes), validExpiry()))
  for (const row of rows) {
    if (row.user.disabledAt) return null
    const secret = decrypt(appPasswordPurpose, row.secretEncrypted)
    const matches = 'password' in credential
      ? sameText(secret, credential.password)
      : sameText(md5(secret + credential.salt), credential.token.toLowerCase())
    if (matches) {
      await touchAppPassword(row.id)
      return row.user
    }
  }
  return null
}

function isUniqueViolation(error: unknown) {
  // drizzle wraps the driver's error in `cause`.
  const candidate = error as { code?: unknown; cause?: { code?: unknown } }
  return candidate.code === '23505' || candidate.cause?.code === '23505'
}

/** Creates an account. A taken username is a 409 `username_taken`. */
export async function insertUser(
  executor: Executor,
  input: Omit<typeof users.$inferInsert, 'id' | 'usernameKey' | 'passwordHash'> & { password: string },
): Promise<typeof users.$inferSelect> {
  const { password, ...values } = input
  try {
    const [row] = await executor.insert(users)
      .values({ ...values, id: newId(), usernameKey: usernameKey(values.username), passwordHash: await hashPassword(password) })
      .returning()
    return row!
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('That username is taken', 'username_taken')
    throw error
  }
}

export async function countUsers(executor: Executor = db): Promise<number> {
  const [row] = await executor.select({ count: sql<number>`count(*)::int` }).from(users)
  return row?.count ?? 0
}
