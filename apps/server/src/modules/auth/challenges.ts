import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { authChallenges, type AuthChallengeKind } from '../../database/schema.js'
import { hashToken, randomToken } from '../../lib/crypto.js'
import { newId } from '../../lib/ids.js'

export type AuthChallenge = typeof authChallenges.$inferSelect

/**
 * Starts a step of a sign-in. The token goes to the client once; only its hash is kept.
 * Expired challenges are swept here, so the table stays small without a job.
 */
export async function createChallenge(input: {
  kind: AuthChallengeKind
  userId?: string | null
  data?: Record<string, unknown>
  ttlMs: number
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date()))
  await db.insert(authChallenges).values({
    id: newId(),
    tokenHash: hashToken(token),
    kind: input.kind,
    userId: input.userId ?? null,
    data: input.data ?? {},
    expiresAt,
  })
  return { token, expiresAt }
}

/** The live challenge of `kind` for a token, without using it up. */
export async function findChallenge(kind: AuthChallengeKind, token: string): Promise<AuthChallenge | null> {
  const [row] = await db.select().from(authChallenges).where(and(
    eq(authChallenges.tokenHash, hashToken(token)),
    eq(authChallenges.kind, kind),
    gt(authChallenges.expiresAt, new Date()),
  ))
  return row ?? null
}

/**
 * Uses a challenge up. Only one caller gets it back, so two requests racing with the same
 * token cannot both finish the sign-in.
 */
export async function consumeChallenge(kind: AuthChallengeKind, token: string): Promise<AuthChallenge | null> {
  const [row] = await db.delete(authChallenges).where(and(
    eq(authChallenges.tokenHash, hashToken(token)),
    eq(authChallenges.kind, kind),
    gt(authChallenges.expiresAt, new Date()),
  )).returning()
  return row ?? null
}

/** Counts a wrong answer; at `limit` the challenge is gone and the sign-in starts over. */
export async function failChallenge(id: string, limit: number) {
  const [row] = await db.update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(eq(authChallenges.id, id))
    .returning({ attempts: authChallenges.attempts })
  if (row && row.attempts >= limit) await db.delete(authChallenges).where(eq(authChallenges.id, id))
}

/** Drops a user's unfinished sign-ins, when their password changes or an admin locks them out. */
export async function dropUserChallenges(executor: Executor, userId: string) {
  await executor.delete(authChallenges).where(eq(authChallenges.userId, userId))
}
