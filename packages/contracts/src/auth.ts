import { z } from 'zod'
import { Id, IsoDateTime, page } from './common.js'

export const UserRole = z.enum(['admin', 'member'])
export type UserRole = z.infer<typeof UserRole>

export const Username = z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, dots, dashes and underscores only')
export const Password = z.string().min(8).max(200)

export const User = z.object({
  id: Id,
  username: z.string(),
  displayName: z.string().nullable(),
  role: UserRole,
  canUpload: z.boolean(),
  canAcquire: z.boolean(),
  createdAt: IsoDateTime,
  disabled: z.boolean(),
  /**
   * An admin turned explicit content off for this user (a child's account), who cannot turn
   * it back on. Older servers leave it out.
   */
  explicitRestricted: z.boolean().default(false),
  /**
   * Whether explicit songs play for this user: their `allowExplicit` setting, unless an admin
   * restricted it. Clients gray explicit songs when it is false (client-core's `isPlayable`).
   * Older servers leave it out, and they play everything.
   */
  allowsExplicit: z.boolean().default(true),
})
export type User = z.infer<typeof User>

export const UserList = page(User)
export type UserList = z.infer<typeof UserList>

/**
 * `GET /setup/status`. `needsSetup` is true until the first admin exists.
 * `registrationRequiresInvite` lets sign-in screens say whether anyone can join.
 * `wantlistEnabled` tells clients whether to show the wantlist at all; servers from before
 * the setting leave it out, and the default hides it there too.
 */
export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  version: z.string(),
  serverName: z.string(),
  registrationRequiresInvite: z.boolean(),
  wantlistEnabled: z.boolean().default(false),
  /** Older servers omit this and accept TVs that identify as `other`. */
  supportsTvDevices: z.literal(true).optional(),
})
export type SetupStatus = z.infer<typeof SetupStatus>

/** Identifies the calling install. `id` is generated once per install and kept. */
export const ClientDevice = z.object({
  id: z.string().min(8).max(80),
  name: z.string().min(1).max(80),
  kind: z.enum(['ios', 'android', 'tv', 'web', 'desktop', 'other']),
})
export type ClientDevice = z.infer<typeof ClientDevice>

export const SetupRequest = z.object({ username: Username, password: Password, device: ClientDevice.optional() })
export type SetupRequest = z.infer<typeof SetupRequest>

/** Bounded like the fields they must match, so a sign-in cannot hand argon2 megabytes. */
export const LoginRequest = z.object({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(200), device: ClientDevice.optional() })
export type LoginRequest = z.infer<typeof LoginRequest>

/** `inviteCode` is required unless the operator turned off `registrationRequiresInvite`. */
export const RegisterRequest = z.object({ inviteCode: z.string().min(1).optional(), username: Username, password: Password, device: ClientDevice.optional() })
export type RegisterRequest = z.infer<typeof RegisterRequest>

/**
 * Returned by setup, login and register. Browsers also receive an httpOnly cookie and
 * should ignore `token`; native clients store `token` and send it as a bearer token.
 */
export const AuthResponse = z.object({ user: User, token: z.string() })
export type AuthResponse = z.infer<typeof AuthResponse>

/**
 * Changing the password also deletes the account's app passwords, since one minted by
 * whoever had the old password would otherwise outlive it. `keepAppPasswords` opts out,
 * for someone who only wants a new password and trusts every app password they made.
 */
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: Password,
  keepAppPasswords: z.boolean().default(false),
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>

export const Invite = z.object({
  id: Id,
  code: z.string(),
  role: UserRole,
  canUpload: z.boolean(),
  canAcquire: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  /** Username of the account that redeemed it. */
  usedBy: z.string().nullable(),
  createdAt: IsoDateTime,
})
export type Invite = z.infer<typeof Invite>

export const InviteList = page(Invite)
export type InviteList = z.infer<typeof InviteList>

export const CreateInviteRequest = z.object({
  role: UserRole.default('member'),
  canUpload: z.boolean().default(false),
  canAcquire: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(14),
})
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>

export const CreateUserRequest = z.object({
  username: Username,
  password: Password,
  displayName: z.string().max(80).nullable().default(null),
  role: UserRole.default('member'),
  canUpload: z.boolean().default(false),
  canAcquire: z.boolean().default(false),
  explicitRestricted: z.boolean().default(false),
})
export type CreateUserRequest = z.infer<typeof CreateUserRequest>

export const UpdateUserRequest = z.object({
  displayName: z.string().max(80).nullable().optional(),
  role: UserRole.optional(),
  canUpload: z.boolean().optional(),
  canAcquire: z.boolean().optional(),
  disabled: z.boolean().optional(),
  password: Password.optional(),
  /** Turns explicit content off for the user and keeps it off, or lifts that. */
  explicitRestricted: z.boolean().optional(),
})
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>

export const ApiTokenScope = z.enum(['library:read', 'playback:control', 'playlists:manage', 'admin'])
export type ApiTokenScope = z.infer<typeof ApiTokenScope>

/** Credential for Subsonic clients or the native API. `secret` is only present in the create response. */
export const AppPassword = z.object({
  id: Id,
  name: z.string(),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  secret: z.string().optional(),
  scopes: z.array(ApiTokenScope).nullable().optional(),
  expiresAt: IsoDateTime.nullable().optional(),
})
export type AppPassword = z.infer<typeof AppPassword>

export const AppPasswordList = page(AppPassword)
export type AppPasswordList = z.infer<typeof AppPasswordList>

/** Most app passwords one account may hold. */
export const APP_PASSWORD_LIMIT = 50

/**
 * `currentPassword` is the account password: a borrowed session alone must not be able to
 * mint a credential that outlives it. Servers answer `current_password_required` to
 * clients that do not send it yet.
 */
export const CreateAppPasswordRequest = z.object({
  name: z.string().trim().min(1).max(60),
  currentPassword: z.string().min(1).max(200),
  scopes: z.array(ApiTokenScope).min(1).max(4).optional(),
  expiresAt: IsoDateTime.optional(),
})
export type CreateAppPasswordRequest = z.infer<typeof CreateAppPasswordRequest>
