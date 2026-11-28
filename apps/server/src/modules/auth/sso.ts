import { Username, type SsoIdentity } from '@squirmy/contracts'
import { and, count, eq } from 'drizzle-orm'
import * as oidc from 'openid-client'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { passkeys, ssoIdentities, users } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'
import { getServerSecret, getServerSettings } from '../../lib/settings.js'
import { newId } from '../../lib/ids.js'
import { usernameKey } from './service.js'

/** OpenID Connect single sign-on: one provider, set up in Admin → Server settings. */
export type SsoProvider = {
  name: string
  issuerUrl: string
  clientId: string
  clientSecret: string | null
  scopes: string
  usernameClaim: string
  groupsClaim: string
  allowedGroups: string[]
  autoCreateUsers: boolean
  callbackUrl: string
}

/** Where the provider sends the browser back. Registered with the provider by the admin. */
export function ssoCallbackUrl(): string | null {
  const publicUrl = getConfig().PUBLIC_URL
  return publicUrl ? `${new URL(publicUrl).origin}/api/v1/auth/sso/callback` : null
}

/** Groups in the allowed-groups setting: commas or spaces between them. */
export function parseGroups(text: string): string[] {
  return text.split(/[\s,]+/).map((group) => group.trim()).filter(Boolean)
}

/** The provider when single sign-on is on and set up; otherwise null. */
export async function ssoProvider(options: { evenIfOff?: boolean } = {}): Promise<SsoProvider | null> {
  const settings = await getServerSettings()
  const callbackUrl = ssoCallbackUrl()
  if ((!settings.ssoEnabled && !options.evenIfOff) || !settings.ssoIssuerUrl || !settings.ssoClientId || !callbackUrl) return null
  return {
    name: settings.ssoName,
    issuerUrl: settings.ssoIssuerUrl,
    clientId: settings.ssoClientId,
    clientSecret: await getServerSecret('ssoClientSecret'),
    scopes: settings.ssoScopes,
    usernameClaim: settings.ssoUsernameClaim,
    groupsClaim: settings.ssoGroupsClaim,
    allowedGroups: parseGroups(settings.ssoAllowedGroups),
    autoCreateUsers: settings.ssoAutoCreateUsers,
    callbackUrl,
  }
}

const discoveryMs = 60 * 60 * 1000
let discovered: { key: string; at: number; config: Promise<oidc.Configuration> } | undefined

/** Forgets the provider's discovered metadata, after its settings change. */
export function forgetSsoDiscovery() {
  discovered = undefined
}

/**
 * The provider's metadata from its discovery document, kept for an hour. Plain http is allowed
 * for an issuer the admin typed as http (a provider on the same private network), never by
 * downgrading an https one.
 */
function configuration(provider: SsoProvider): Promise<oidc.Configuration> {
  const key = JSON.stringify([provider.issuerUrl, provider.clientId, provider.clientSecret])
  if (discovered?.key === key && Date.now() - discovered.at < discoveryMs) return discovered.config
  const issuer = new URL(provider.issuerUrl)
  const insecure = issuer.protocol === 'http:'
  const config = (async () => {
    const auth = provider.clientSecret ? oidc.ClientSecretBasic(provider.clientSecret) : oidc.None()
    let found = await oidc.discovery(issuer, provider.clientId, undefined, auth, { execute: insecure ? [oidc.allowInsecureRequests] : [], timeout: 10 })
    // Some providers take the secret only in the form body.
    const methods = found.serverMetadata().token_endpoint_auth_methods_supported
    if (provider.clientSecret && methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
      found = new oidc.Configuration(found.serverMetadata(), provider.clientId, undefined, oidc.ClientSecretPost(provider.clientSecret))
      if (insecure) oidc.allowInsecureRequests(found)
    }
    found.timeout = 10
    return found
  })()
  discovered = { key, at: Date.now(), config }
  config.catch(() => { if (discovered?.config === config) discovered = undefined })
  return config
}

/** Runs discovery now, for the admin's Test button. */
export async function testSsoProvider(provider: SsoProvider): Promise<{ issuer: string }> {
  forgetSsoDiscovery()
  const config = await configuration(provider)
  return { issuer: config.serverMetadata().issuer }
}

/** PKCE, state and nonce for one round trip; kept server-side with the state as the key. */
export function newSsoSecrets() {
  return { verifier: oidc.randomPKCECodeVerifier(), nonce: oidc.randomNonce() }
}

export async function authorizationUrl(provider: SsoProvider, input: { state: string; nonce: string; verifier: string }): Promise<string> {
  const config = await configuration(provider)
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: provider.callbackUrl,
    scope: provider.scopes,
    state: input.state,
    nonce: input.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(input.verifier),
    code_challenge_method: 'S256',
  }).href
}

export type SsoClaims = { issuer: string; subject: string; claims: Record<string, unknown> }

/**
 * Exchanges the code at the token endpoint and checks the ID token (signature, issuer, audience,
 * expiry, nonce) and the state. Userinfo, when the provider has it, adds claims the ID token
 * leaves out (Authelia puts groups there); it must name the same subject.
 */
export async function finishSso(provider: SsoProvider, callback: URL, checks: { state: string; nonce: string; verifier: string }): Promise<SsoClaims> {
  const config = await configuration(provider)
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: checks.verifier,
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    idTokenExpected: true,
  })
  const idClaims = tokens.claims()!
  let extra: Record<string, unknown> = {}
  if (config.serverMetadata().userinfo_endpoint) {
    extra = await oidc.fetchUserInfo(config, tokens.access_token, idClaims.sub) as Record<string, unknown>
  }
  return { issuer: idClaims.iss, subject: idClaims.sub, claims: { ...extra, ...idClaims } }
}

/** A claim by name, or by a dotted path into nested claims (Keycloak's `realm_access.roles`). */
export function claimValue(claims: Record<string, unknown>, name: string): unknown {
  if (name in claims) return claims[name]
  let value: unknown = claims
  for (const part of name.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export function claimGroups(claims: Record<string, unknown>, name: string): string[] {
  const value = claimValue(claims, name)
  if (Array.isArray(value)) return value.filter((group): group is string => typeof group === 'string')
  return typeof value === 'string' ? parseGroups(value) : []
}

/** Whether the person is in one of the allowed groups, or no groups are required. */
export function inAllowedGroups(provider: SsoProvider, claims: Record<string, unknown>): boolean {
  if (provider.allowedGroups.length === 0) return true
  const groups = new Set(claimGroups(claims, provider.groupsClaim))
  return provider.allowedGroups.some((group) => groups.has(group))
}

/** The email, only when the provider says it checked it. */
export function verifiedEmail(claims: Record<string, unknown>): string | null {
  const email = claims.email
  const verified = claims.email_verified === true || claims.email_verified === 'true'
  return verified && typeof email === 'string' && email.includes('@') ? email.trim() : null
}

/**
 * A Squirmy username from the username claim: an email's part before the @, other characters
 * than letters, digits, dots, dashes and underscores as dashes. Null when nothing usable is left.
 */
export function usernameFromClaims(claims: Record<string, unknown>, claim: string): string | null {
  const value = claimValue(claims, claim)
  if (typeof value !== 'string') return null
  const local = value.includes('@') ? value.slice(0, value.indexOf('@')) : value
  const cleaned = local.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return Username.safeParse(cleaned).success ? cleaned : null
}

export async function findSsoUser(issuer: string, subject: string) {
  const [row] = await db.select({ user: users, identityId: ssoIdentities.id }).from(ssoIdentities)
    .innerJoin(users, eq(users.id, ssoIdentities.userId))
    .where(and(eq(ssoIdentities.issuer, issuer), eq(ssoIdentities.subject, subject)))
  if (row) await db.update(ssoIdentities).set({ lastUsedAt: new Date() }).where(eq(ssoIdentities.id, row.identityId))
  return row?.user ?? null
}

export async function findUserByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.emailKey, email.toLowerCase()))
  return row ?? null
}

/** Links an identity to a user. Resolves to false when the identity belongs to someone else. */
export async function linkSsoIdentity(userId: string, identity: SsoClaims): Promise<boolean> {
  const email = typeof identity.claims.email === 'string' ? identity.claims.email : null
  const [row] = await db.insert(ssoIdentities)
    .values({ id: newId(), userId, issuer: identity.issuer, subject: identity.subject, email, lastUsedAt: new Date() })
    .onConflictDoUpdate({
      target: [ssoIdentities.issuer, ssoIdentities.subject],
      set: { email, lastUsedAt: new Date() },
      // Only refreshes a link that is already this user's.
      setWhere: eq(ssoIdentities.userId, userId),
    })
    .returning({ userId: ssoIdentities.userId })
  return row?.userId === userId
}

export async function listSsoIdentities(userId: string): Promise<SsoIdentity[]> {
  const rows = await db.select().from(ssoIdentities).where(eq(ssoIdentities.userId, userId))
  return rows.map((row) => ({
    id: row.id,
    issuer: row.issuer,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }))
}

export async function hasSsoIdentity(userId: string): Promise<boolean> {
  const [row] = await db.select({ count: count() }).from(ssoIdentities).where(eq(ssoIdentities.userId, userId))
  return (row?.count ?? 0) > 0
}

/**
 * Unlinks an identity, unless it is the only way left into the account (no password, no
 * passkey, no other identity). Resolves to false when there was no such identity.
 */
export async function unlinkSsoIdentity(userId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).for('update')
    const [identity] = await tx.select({ id: ssoIdentities.id }).from(ssoIdentities).where(and(eq(ssoIdentities.id, id), eq(ssoIdentities.userId, userId)))
    if (!user || !identity) return false
    if (!user.passwordHash) {
      const [others] = await tx.select({ count: count() }).from(ssoIdentities).where(eq(ssoIdentities.userId, userId))
      const [keys] = await tx.select({ count: count() }).from(passkeys).where(eq(passkeys.userId, userId))
      if ((others?.count ?? 0) <= 1 && (keys?.count ?? 0) === 0) {
        throw conflict('This is the only way into your account. Ask an admin to set a password first.', 'last_sign_in_method')
      }
    }
    await tx.delete(ssoIdentities).where(eq(ssoIdentities.id, id))
    return true
  })
}

/** Whether a username is free, compared as sign-in compares it. */
export async function usernameTaken(username: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.usernameKey, usernameKey(username)))
  return !!row
}
