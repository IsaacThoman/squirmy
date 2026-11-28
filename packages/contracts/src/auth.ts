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
  /** Set by an admin; single sign-on links a provider account with the same verified address. */
  email: z.string().nullable().optional(),
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

export const Email = z.email().max(254)

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
  /** Whether members can make public share links. Older servers have none. */
  sharingEnabled: z.boolean().default(false),
  /** Older servers omit this and accept TVs that identify as `other`. */
  supportsTvDevices: z.literal(true).optional(),
  supportsTvPairing: z.literal(true).optional(),
  /** Whether the sign-in page can offer passkeys: PUBLIC_URL is an https address (or localhost). */
  passkeysAvailable: z.boolean().default(false),
  /** The single sign-on provider's name for "Sign in with …", or null when it is off. */
  ssoName: z.string().nullable().default(null),
  /** False when the admin turned password sign-in off: sign-in offers single sign-on and passkeys only. */
  passwordLoginEnabled: z.boolean().default(true),
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

/** Eight characters with ambiguous glyphs removed, with an optional dash when entered. */
export const pairingAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PairingUserCode = z.string().trim().toUpperCase()
  .regex(/^[2-9A-HJ-NP-Z]{4}-?[2-9A-HJ-NP-Z]{4}$/, 'Enter the eight characters shown on the TV.')
  .transform(code => code.replace('-', ''))
const PairingDeviceCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const StartTvPairing = z.object({
  device: ClientDevice.extend({ kind: z.literal('tv'), name: ClientDevice.shape.name.trim().min(1) }),
})
export const TvPairing = z.object({
  deviceCode: PairingDeviceCode,
  userCode: z.string(),
  verificationUrl: z.url(),
  qrCode: z.string(),
  expiresAt: IsoDateTime,
  expiresInSeconds: z.number().int().positive(),
  intervalSeconds: z.number().int().positive(),
})
export type TvPairing = z.infer<typeof TvPairing>

export const PollTvPairing = z.object({ deviceCode: PairingDeviceCode })
export const TvPairingPoll = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'slow_down']), intervalSeconds: z.number().int().positive() }),
  z.object({ status: z.literal('approved'), session: AuthResponse }),
])
export type TvPairingPoll = z.infer<typeof TvPairingPoll>

export const LookupTvPairing = z.object({ code: PairingUserCode })
export const TvPairingPreview = z.object({
  id: Id,
  deviceName: z.string(),
  ipAddress: z.string(),
})
export type TvPairingPreview = z.infer<typeof TvPairingPreview>

export const ApproveTvPairing = LookupTvPairing.extend({ id: Id })

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
  email: Email.nullable().default(null),
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
  email: Email.nullable().optional(),
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
 * clients that do not send it yet. An account without a password (made by single sign-on)
 * leaves it out and needs a sign-in from the last few minutes instead.
 */
export const CreateAppPasswordRequest = z.object({
  name: z.string().trim().min(1).max(60),
  currentPassword: z.string().min(1).max(200).optional(),
  scopes: z.array(ApiTokenScope).min(1).max(4).optional(),
  expiresAt: IsoDateTime.optional(),
})
export type CreateAppPasswordRequest = z.infer<typeof CreateAppPasswordRequest>

// ---------------------------------------------------------------------------
// Sessions and two-factor authentication
// ---------------------------------------------------------------------------

/**
 * How a session was signed in. Null for sessions from before the server recorded it. Values a
 * newer server adds read as null, so an older client still lists the session.
 */
export const SignInMethod = z.enum(['password', 'two_factor', 'recovery_code', 'passkey', 'sso', 'tv_pairing'])
export type SignInMethod = z.infer<typeof SignInMethod>

/** One signed-in browser or app. `current` is the session making the request. */
export const AuthSession = z.object({
  id: Id,
  current: z.boolean(),
  /** `web`, `ios`, `tv` and so on, as the client said when it signed in. */
  clientKind: z.string(),
  /** The device's own name, when the client named one. */
  deviceName: z.string().nullable(),
  userAgent: z.string().nullable(),
  method: SignInMethod.nullable().catch(null),
  createdAt: IsoDateTime,
  /** Written at most once a minute. */
  lastSeenAt: IsoDateTime,
  expiresAt: IsoDateTime,
})
export type AuthSession = z.infer<typeof AuthSession>

export const AuthSessionList = page(AuthSession)
export type AuthSessionList = z.infer<typeof AuthSessionList>

/** Recovery codes a new set holds. Each works once, in place of an authenticator code. */
export const RECOVERY_CODE_COUNT = 10

export const TwoFactorStatus = z.object({
  enabled: z.boolean(),
  enabledAt: IsoDateTime.nullable(),
  recoveryCodesRemaining: z.number().int().min(0),
})
export type TwoFactorStatus = z.infer<typeof TwoFactorStatus>

/** A provider account linked to this one. */
export const SsoIdentity = z.object({
  id: Id,
  issuer: z.string(),
  email: z.string().nullable(),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
})
export type SsoIdentity = z.infer<typeof SsoIdentity>

/** Most passkeys one account may hold. */
export const PASSKEY_LIMIT = 20

/** A passkey of the account. The key itself stays on the device; the server keeps its public half. */
export const Passkey = z.object({
  id: Id,
  name: z.string(),
  /** Synced to other devices by its password manager (iCloud Keychain, Google, 1Password…). */
  backedUp: z.boolean(),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
})
export type Passkey = z.infer<typeof Passkey>

export const PasskeyName = z.string().trim().min(1).max(60)

/** `GET /auth/security`: the ways this account can sign in. */
export const AccountSecurity = z.object({
  /** False for an account made by single sign-on that never had a password set. */
  hasPassword: z.boolean(),
  twoFactor: TwoFactorStatus,
  passkeys: z.array(Passkey).default([]),
  ssoIdentities: z.array(SsoIdentity).default([]),
})
export type AccountSecurity = z.infer<typeof AccountSecurity>

/** Six digits from an authenticator app. Spaces are allowed, as apps show them. */
export const TotpCode = z.string().transform((value) => value.replace(/\s+/g, '')).pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'))

/** An authenticator code or a recovery code. The server tells them apart. */
export const SecondFactorCode = z.string().trim().min(6, 'Enter the code').max(40)

/** `POST /auth/two-factor/setup`. Starts enrolment; nothing changes until the code is confirmed. */
export const StartTwoFactorRequest = z.object({ currentPassword: z.string().min(1).max(200) })
export type StartTwoFactorRequest = z.infer<typeof StartTwoFactorRequest>

/**
 * The secret to add to an authenticator app: scanned from `qrCode` (an SVG data URL, drawn by
 * the server) or typed in as `secret` (base32). `otpauthUrl` is what the QR code holds.
 */
export const TwoFactorSetup = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrCode: z.string(),
})
export type TwoFactorSetup = z.infer<typeof TwoFactorSetup>

/** `POST /auth/two-factor/enable`: the first code from the app proves it was set up right. */
export const EnableTwoFactorRequest = z.object({ code: TotpCode })
export type EnableTwoFactorRequest = z.infer<typeof EnableTwoFactorRequest>

/** Shown once. Only their hashes are kept. */
export const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) })
export type RecoveryCodes = z.infer<typeof RecoveryCodes>

/**
 * Turning two-factor off or making new recovery codes needs the password and a current code
 * (or an unused recovery code), so neither a borrowed session nor a known password alone can.
 */
export const ConfirmTwoFactorRequest = z.object({ currentPassword: z.string().min(1).max(200), code: SecondFactorCode })
export type ConfirmTwoFactorRequest = z.infer<typeof ConfirmTwoFactorRequest>

/**
 * `details` of the 401 `two_factor_required` that `POST /auth/login` answers when the password
 * is right and the account has two-factor on. `challenge` goes back with the code to
 * `POST /auth/login/two-factor`; it lasts until `expiresAt` and a few wrong codes.
 */
export const TwoFactorChallenge = z.object({ challenge: z.string(), expiresAt: IsoDateTime })
export type TwoFactorChallenge = z.infer<typeof TwoFactorChallenge>

export const TwoFactorLoginRequest = z.object({
  challenge: z.string().min(1).max(200),
  code: SecondFactorCode,
  device: ClientDevice.optional(),
})
export type TwoFactorLoginRequest = z.infer<typeof TwoFactorLoginRequest>

/** `GET /admin/users/:id/security`: what an admin may see of someone's sign-ins. */
export const UserSecurity = z.object({
  twoFactorEnabled: z.boolean(),
  sessions: z.array(AuthSession),
  passkeys: z.array(Passkey).default([]),
})
export type UserSecurity = z.infer<typeof UserSecurity>

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn)
// ---------------------------------------------------------------------------

/** WebAuthn's JSON as `@simplewebauthn` reads and writes it; the server library checks the details. */
const WebAuthnJson = z.record(z.string(), z.unknown())

/**
 * A ceremony to hand to the browser (`navigator.credentials`), and the challenge to send back
 * with its answer. The challenge is used once and lasts five minutes.
 */
export const PasskeyOptions = z.object({ challenge: z.string(), options: WebAuthnJson })
export type PasskeyOptions = z.infer<typeof PasskeyOptions>

/** What the browser answered: a `RegistrationResponseJSON` or an `AuthenticationResponseJSON`. */
export const PasskeyCredential = z.looseObject({
  id: z.string().min(1).max(1400),
  rawId: z.string().min(1).max(1400),
  type: z.literal('public-key'),
  response: WebAuthnJson,
  clientExtensionResults: WebAuthnJson.default({}),
})
export type PasskeyCredential = z.infer<typeof PasskeyCredential>

/** `POST /auth/passkeys/options`: a passkey outlives the session it is added from, so the password comes first. */
export const StartPasskeyRequest = z.object({ currentPassword: z.string().min(1).max(200).optional() })
export type StartPasskeyRequest = z.infer<typeof StartPasskeyRequest>

export const RegisterPasskeyRequest = z.object({ challenge: z.string().min(1).max(200), name: PasskeyName, response: PasskeyCredential })
export type RegisterPasskeyRequest = z.infer<typeof RegisterPasskeyRequest>

export const RenamePasskeyRequest = z.object({ name: PasskeyName })
export type RenamePasskeyRequest = z.infer<typeof RenamePasskeyRequest>

export const PasskeyLoginRequest = z.object({ challenge: z.string().min(1).max(200), response: PasskeyCredential, device: ClientDevice.optional() })
export type PasskeyLoginRequest = z.infer<typeof PasskeyLoginRequest>

// ---------------------------------------------------------------------------
// Single sign-on (OpenID Connect)
// ---------------------------------------------------------------------------


/** `POST /auth/sso/link`. The password, when the account has one. */
export const LinkSsoRequest = z.object({ currentPassword: z.string().min(1).max(200).optional() })
export type LinkSsoRequest = z.infer<typeof LinkSsoRequest>

/** Where to send the browser to approve the link at the provider. */
export const SsoLinkStart = z.object({ url: z.string() })
export type SsoLinkStart = z.infer<typeof SsoLinkStart>

/**
 * `POST /auth/sso/exchange`: the iOS app trades the one-time code from its redirect for a
 * session. `verifier` is required when the app sent a `challenge` to `/auth/sso/start`.
 */
export const SsoExchangeRequest = z.object({ code: z.string().min(1).max(200), verifier: z.string().min(43).max(128).optional(), device: ClientDevice.optional() })
export type SsoExchangeRequest = z.infer<typeof SsoExchangeRequest>

/** `POST /admin/sso/test`: whether the provider's discovery document loads with the saved settings. */
export const SsoTestResult = z.object({ ok: z.boolean(), issuer: z.string().nullable(), message: z.string() })
export type SsoTestResult = z.infer<typeof SsoTestResult>
