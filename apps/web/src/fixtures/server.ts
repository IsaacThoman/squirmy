import type {
  AccountSecurity, AppPassword, AuthSession, DeviceInfo, Invite, JobQueueStats, ServerSettings, User, UserSettings,
} from '@squirmy/contracts'

const at = (iso: string) => `2026-11-${iso}:00.000Z`

export const currentUser: User = {
  id: '00000000-0000-4000-8600-000000000001',
  username: 'alex',
  displayName: 'Alex Rivera',
  role: 'admin',
  canUpload: true,
  canAcquire: true,
  createdAt: at('02T09:12'),
  disabled: false,
}

export const users: User[] = [
  currentUser,
  { ...currentUser, id: '00000000-0000-4000-8600-000000000002', username: 'sam', displayName: 'Sam Okafor', role: 'member', canAcquire: false, createdAt: at('05T18:40') },
  { ...currentUser, id: '00000000-0000-4000-8600-000000000003', username: 'robin', displayName: null, role: 'member', canUpload: false, canAcquire: false, createdAt: at('11T12:03') },
  { ...currentUser, id: '00000000-0000-4000-8600-000000000004', username: 'kit', displayName: 'Kit', role: 'member', canUpload: false, canAcquire: false, createdAt: at('12T08:55'), disabled: true },
]

export const invites: Invite[] = [
  { id: '00000000-0000-4000-8700-000000000001', code: 'BLUE-HOUR-7Q2M', role: 'member', canUpload: false, canAcquire: false, expiresAt: at('30T00:00'), usedBy: null, createdAt: at('16T10:00') },
  { id: '00000000-0000-4000-8700-000000000002', code: 'GLASS-CITY-4KX9', role: 'member', canUpload: true, canAcquire: false, expiresAt: null, usedBy: 'robin', createdAt: at('10T10:00') },
]

export const appPasswords: AppPassword[] = [
  { id: '00000000-0000-4000-8700-000000000101', name: 'Car stereo', createdAt: at('03T20:11'), lastUsedAt: at('19T17:45') },
  { id: '00000000-0000-4000-8700-000000000102', name: 'Desktop player', createdAt: at('08T09:30'), lastUsedAt: null },
]

export const userSettings: UserSettings = {
  normalization: 'auto',
  qualityWifi: 'original',
  qualityCellular: 'high',
  downloadQuality: 'original',
  downloadOnWifiOnly: true,
  scrobbleListenBrainz: true,
  scrobbleLastFm: false,
  libraryIncludesServerMusic: false,
  shareNowPlaying: false,
}

export const serverSettings: ServerSettings = {
  serverName: 'Squirmy',
  deezerEnabled: true,
  musicBrainzEnabled: true,
  musicBrainzBaseUrl: 'https://musicbrainz.org',
  coverArtArchiveEnabled: true,
  wikidataEnabled: true,
  lrclibEnabled: true,
  listenBrainzTokenSet: true,
  acoustIdKeySet: false,
  fanartKeySet: false,
  lastFmKeySet: false,
  matchAutoAcceptScore: 0.9,
  missingFileGraceDays: 14,
  transcodeCacheMaxBytes: 10 * 1024 ** 3,
  registrationRequiresInvite: true,
  importRootId: null,
  inboxPath: null,
  importMaxFileBytes: 4 * 1024 ** 3,
  importMaxBytes: 64 * 1024 ** 3,
  importMaxActivePerUser: 3,
  wantlistEnabled: false,
  sonicAnalysisEnabled: true,
  ssoEnabled: false,
  ssoName: 'Single sign-on',
  ssoIssuerUrl: null,
  ssoClientId: null,
  ssoClientSecretSet: false,
  ssoScopes: 'openid profile email',
  ssoUsernameClaim: 'preferred_username',
  ssoGroupsClaim: 'groups',
  ssoAllowedGroups: '',
  ssoAutoCreateUsers: false,
  passwordLoginDisabled: false,
  ssoCallbackUrl: 'https://music.example.com/api/v1/auth/sso/callback',
}

export const jobs: JobQueueStats[] = [
  { name: 'library.scan', queued: 0, active: 1, failed: 0 },
  { name: 'library.probe', queued: 5502, active: 4, failed: 2 },
  { name: 'library.ingest', queued: 31, active: 1, failed: 0 },
  { name: 'library.analyze', queued: 1840, active: 2, failed: 0 },
  { name: 'matching.match-album', queued: 12, active: 1, failed: 1 },
  { name: 'enrichment.album', queued: 0, active: 0, failed: 0 },
]

export const thisDeviceId = 'web-this-browser'

export const devices: DeviceInfo[] = [
  { id: thisDeviceId, name: 'This browser', kind: 'web', canPlay: true, isActive: true },
  { id: 'phone', name: 'Alex’s iPhone', kind: 'ios', canPlay: true, isActive: false },
  { id: 'living-room', name: 'Living Room', kind: 'other', canPlay: true, isActive: false },
  // Quiet for hours: the list says how long, which tells two devices of one name apart.
  { id: 'studio-mac', name: 'Studio Mac', kind: 'desktop', canPlay: true, isActive: false, lastSeenAt: Date.now() - 3 * 3_600_000 },
  // Playing its own queue: listed apart, never a place to move playback to.
  { id: 'kitchen', name: 'Kitchen', kind: 'web', canPlay: false, isActive: false, detached: { playing: false, trackId: '00000000-0000-4000-8300-000000000001', albumId: null } },
]

export const accountSecurity: AccountSecurity = {
  hasPassword: true,
  twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: 0 },
  passkeys: [
    { id: '00000000-0000-4000-8900-000000000001', name: 'MacBook', backedUp: true, createdAt: at('14T10:00'), lastUsedAt: at('26T09:30') },
  ],
  ssoIdentities: [],
}

export const authSessions: AuthSession[] = [
  {
    id: '00000000-0000-4000-8800-000000000001', current: true, clientKind: 'web', deviceName: 'Firefox on macOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5) Gecko/20100101 Firefox/140.0',
    method: 'password', createdAt: at('20T08:00'), lastSeenAt: at('27T21:30'), expiresAt: '2027-05-26T21:30:00.000Z',
  },
  {
    id: '00000000-0000-4000-8800-000000000002', current: false, clientKind: 'ios', deviceName: 'Alex’s iPhone', userAgent: 'Squirmy/1.0 CFNetwork',
    method: 'two_factor', createdAt: at('12T19:45'), lastSeenAt: at('27T18:05'), expiresAt: '2027-05-26T18:05:00.000Z',
  },
  {
    id: '00000000-0000-4000-8800-000000000003', current: false, clientKind: 'web', deviceName: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
    method: null, createdAt: at('03T10:20'), lastSeenAt: at('09T14:00'), expiresAt: '2027-05-08T14:00:00.000Z',
  },
]
