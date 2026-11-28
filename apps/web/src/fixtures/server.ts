import type {
  AppPassword, DeviceInfo, Invite, JobQueueStats, PublicShare, ServerSettings, ShareLink, User, UserSettings,
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

export const shareLinks: ShareLink[] = [
  {
    id: '00000000-0000-4000-8700-000000000201', kind: 'album', targetId: '00000000-0000-4000-8000-000000000301', title: 'Blue Hour', subtitle: 'Mira Vale', artwork: null,
    createdAt: at('20T18:02'), expiresAt: at('27T18:02'), expired: false, openCount: 4, lastOpenedAt: at('21T09:15'),
  },
  {
    id: '00000000-0000-4000-8700-000000000202', kind: 'playlist', targetId: '00000000-0000-4000-8000-000000000302', title: 'Late drive', subtitle: null, artwork: null,
    createdAt: at('12T22:40'), expiresAt: null, expired: false, openCount: 0, lastOpenedAt: null,
  },
  {
    id: '00000000-0000-4000-8700-000000000203', kind: 'track', targetId: '00000000-0000-4000-8000-000000000303', title: 'Night Swimming', subtitle: 'Mira Vale', artwork: null,
    createdAt: at('02T08:00'), expiresAt: at('03T08:00'), expired: true, openCount: 12, lastOpenedAt: at('02T23:59'),
  },
]

export const publicShare: PublicShare = {
  kind: 'album', title: 'Blue Hour', artistCredit: 'Mira Vale', year: 2024, artwork: null, durationMs: 401_000, playback: 'previews', expiresAt: at('27T18:02'), serverName: 'Squirmy',
  tracks: [
    { id: '00000000-0000-4000-8000-000000000401', title: 'Night Swimming', artistCredit: 'Mira Vale', albumTitle: null, artwork: null, durationMs: 214_000, disc: 1, position: 1, explicit: null, available: true },
    { id: '00000000-0000-4000-8000-000000000402', title: 'Glass City', artistCredit: 'Mira Vale', albumTitle: null, artwork: null, durationMs: 187_000, disc: 1, position: 2, explicit: false, available: false },
  ],
}

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
  sharingEnabled: true,
  sharePlayback: 'previews',
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
