import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  CreateInviteRequest, CreateUserRequest, DirectoryQuery, Id, queryKeys, UpdateServerSettings, UpdateUserRequest,
  type DirectoryListing, type Invite, type InviteList, type JobQueueStats, type Ok, type ServerSettings, type User, type UserList, type UserSecurity,
} from '@squirmy/contracts'
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, type Transaction } from '../../database/client.js'
import { invites, users } from '../../database/schema.js'
import { requireAdmin } from '../../lib/auth.js'
import { randomToken } from '../../lib/crypto.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings, invalidateServerSettings, updateServerSettings } from '../../lib/settings.js'
import { getQueueStats } from '../../jobs/index.js'
import { disconnectSockets, invalidate } from '../../realtime/index.js'
import { dropUserChallenges } from '../auth/challenges.js'
import { hashPassword, insertUser, listSessions, revokeAppPasswords, revokeUserSession, revokeUserSessions, toUser } from '../auth/service.js'
import { disableTwoFactor, twoFactorEnabled } from '../auth/two-factor.js'
import { markEnrichmentStale } from '../enrichment/stale.js'
import { queueNewlyPossibleMatching } from '../matching/retry.js'
import { queueSonicSweep } from '../sonic/index.js'
import { checkImportSettings } from '../imports/settings.js'

const IdParams = z.object({ id: Id })
const SessionParams = z.object({ id: Id, sessionId: Id })

async function requireUserRow(id: string) {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id))
  if (!row) throw notFound('No such user')
}

/**
 * Fails unless another enabled admin would remain once `userId` stops being one. Holds a
 * transaction lock so two requests cannot each remove a different last-but-one admin.
 */
async function keepAnAdmin(tx: Transaction, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:admins'))`)
  const [other] = await tx.select({ id: users.id }).from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, userId)))
    .limit(1)
  if (!other) throw conflict('The server needs at least one active admin', 'last_admin')
}

function toInvite(row: typeof invites.$inferSelect, usedBy: string | null): Invite {
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    canUpload: row.canUpload,
    canAcquire: row.canAcquire,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    usedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

async function listDirectories(requested: string): Promise<DirectoryListing> {
  let directory: string
  try {
    directory = await realpath(requested)
    if (!(await stat(directory)).isDirectory()) throw badRequest('Not a directory', 'not_a_directory')
  } catch (error) {
    if (error instanceof AppError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw notFound('No such directory')
    if (code === 'EACCES' || code === 'EPERM') throw forbidden('The server cannot read that directory', 'permission_denied')
    throw error
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') throw forbidden('The server cannot read that directory', 'permission_denied')
    throw error
  }
  const directories: DirectoryListing['directories'] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(directory, entry.name)
    // A symlink counts when it points at a directory; broken links are skipped.
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && await stat(full).then((info) => info.isDirectory(), () => false))
    if (isDirectory) directories.push({ name: entry.name, path: full })
  }
  directories.sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(directory)
  return { path: directory, parent: parent === directory ? null : parent, directories }
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.get('/admin/users', async (): Promise<UserList> => {
    const rows = await db.select().from(users).orderBy(asc(users.usernameKey))
    return { items: rows.map(toUser), nextCursor: null }
  })

  app.post('/admin/users', async (request, reply): Promise<User> => {
    const body = CreateUserRequest.parse(request.body)
    const user = await insertUser(db, body)
    await invalidate('admins', [queryKeys.adminUsers()])
    reply.code(201)
    return toUser(user)
  })

  app.patch('/admin/users/:id', async (request): Promise<User> => {
    const { id } = IdParams.parse(request.params)
    const body = UpdateUserRequest.parse(request.body)
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update')
      if (!current) throw notFound('No such user')
      const losesAdmin = current.role === 'admin' && !current.disabledAt && (body.role === 'member' || body.disabled === true)
      if (losesAdmin) await keepAnAdmin(tx, id)
      const [row] = await tx.update(users).set({
        displayName: body.displayName,
        role: body.role,
        canUpload: body.canUpload,
        canAcquire: body.canAcquire,
        ...(body.disabled !== undefined && { disabledAt: body.disabled ? current.disabledAt ?? new Date() : null }),
        ...(body.password !== undefined && { passwordHash: await hashPassword(body.password) }),
        updatedAt: new Date(),
      }).where(eq(users.id, id)).returning()
      if (body.password !== undefined || body.disabled) {
        await revokeUserSessions(tx, id)
        await dropUserChallenges(tx, id)
        // An app password minted by whoever had the account would survive the reset.
        await revokeAppPasswords(tx, id)
      }
      return row!
    })
    // Sockets carry the role and session they connected with; make them reconnect.
    if (body.role !== undefined || body.disabled || body.password !== undefined) await disconnectSockets(id)
    await invalidate('admins', [queryKeys.adminUsers()])
    await invalidate({ user: id }, [queryKeys.me()])
    return toUser(updated)
  })

  app.delete('/admin/users/:id', async (request): Promise<Ok> => {
    const { id } = IdParams.parse(request.params)
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update')
      if (!current) throw notFound('No such user')
      if (current.role === 'admin' && !current.disabledAt) await keepAnAdmin(tx, id)
      await tx.delete(users).where(eq(users.id, id))
    })
    await disconnectSockets(id)
    await invalidate('admins', [queryKeys.adminUsers()])
    return { ok: true }
  })

  app.get('/admin/users/:id/security', async (request): Promise<UserSecurity> => {
    const { id } = IdParams.parse(request.params)
    await requireUserRow(id)
    return { twoFactorEnabled: await twoFactorEnabled(id), sessions: await listSessions(id, request.authSessionId) }
  })

  app.delete('/admin/users/:id/sessions/:sessionId', async (request): Promise<Ok> => {
    const { id, sessionId } = SessionParams.parse(request.params)
    if (!await revokeUserSession(id, sessionId)) throw notFound('No such session')
    await disconnectSockets(id, { only: sessionId })
    return { ok: true }
  })

  app.delete('/admin/users/:id/sessions', async (request): Promise<Ok> => {
    const { id } = IdParams.parse(request.params)
    await requireUserRow(id)
    // An admin signing themselves out everywhere keeps the session they are using.
    const keep = id === request.user!.id ? request.authSessionId ?? undefined : undefined
    await revokeUserSessions(db, id, keep)
    await disconnectSockets(id, keep ? { except: keep } : {})
    return { ok: true }
  })

  /** For someone who lost their authenticator and their recovery codes. Their sessions stay. */
  app.delete('/admin/users/:id/two-factor', async (request): Promise<Ok> => {
    const { id } = IdParams.parse(request.params)
    // An admin's own second factor is turned off from their settings, with their password and a
    // code, so a borrowed admin session cannot remove it here.
    if (id === request.user!.id) throw forbidden('Turn off your own two-factor authentication in Settings → Security', 'own_two_factor')
    await requireUserRow(id)
    await disableTwoFactor(db, id)
    return { ok: true }
  })

  app.get('/admin/invites', async (): Promise<InviteList> => {
    const redeemer = alias(users, 'redeemer')
    const rows = await db.select({ invite: invites, usedBy: redeemer.username }).from(invites)
      .leftJoin(redeemer, eq(redeemer.id, invites.usedBy))
      .orderBy(desc(invites.createdAt))
    return { items: rows.map((row) => toInvite(row.invite, row.usedBy)), nextCursor: null }
  })

  app.post('/admin/invites', async (request, reply): Promise<Invite> => {
    const admin = requireAdmin(request)
    const body = CreateInviteRequest.parse(request.body)
    const [row] = await db.insert(invites).values({
      id: newId(),
      code: randomToken(9),
      role: body.role,
      canUpload: body.canUpload,
      canAcquire: body.canAcquire,
      createdBy: admin.id,
      expiresAt: body.expiresInDays === null ? null : new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000),
    }).returning()
    reply.code(201)
    return toInvite(row!, null)
  })

  app.delete('/admin/invites/:id', async (request): Promise<Ok> => {
    const { id } = IdParams.parse(request.params)
    const deleted = await db.delete(invites).where(eq(invites.id, id)).returning({ id: invites.id })
    if (deleted.length === 0) throw notFound('No such invite')
    return { ok: true }
  })

  app.get('/admin/settings', async (): Promise<ServerSettings> => getServerSettings())

  app.patch('/admin/settings', async (request): Promise<ServerSettings> => {
    const patch = await checkImportSettings(UpdateServerSettings.parse(request.body))
    invalidateServerSettings()
    const before = await getServerSettings()
    const settings = await updateServerSettings(patch)
    // Owned by the enrichment module: music enriched without a source that is now on.
    await markEnrichmentStale(before, settings)
    // Owned by the matching module: identification that was not possible before.
    await queueNewlyPossibleMatching(before, settings)
    // Owned by the sonic module: analysis switched on starts now.
    await queueSonicSweep(before, settings)
    await invalidate('admins', [queryKeys.admin()])
    // Clients read the switch from the setup status, and Home and the wantlist answer
    // differently with it off, so open apps show or hide the wantlist without a reload.
    if (before.wantlistEnabled !== settings.wantlistEnabled) {
      await invalidate('all', [queryKeys.setupStatus(), queryKeys.home(), queryKeys.wants()])
    }
    return settings
  })

  app.get('/admin/jobs', async (): Promise<JobQueueStats[]> => getQueueStats())

  app.get('/admin/fs', async (request): Promise<DirectoryListing> => {
    const query = DirectoryQuery.parse(request.query)
    if (query.path !== undefined && !path.isAbsolute(query.path)) throw badRequest('Give an absolute path', 'relative_path')
    return listDirectories(query.path ?? homedir())
  })
}
