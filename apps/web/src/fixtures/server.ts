import type {
  AppPassword, DeviceInfo, Invite, JobQueueStats, LibraryRoot, LibraryStats, ServerSettings, User, UserSettings,
} from '@squirmy/contracts'
import { album, albums } from './catalog'

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
}

export const libraryRoots: LibraryRoot[] = [
  {
    id: '00000000-0000-4000-8a00-000000000001', name: 'Music', path: '/srv/music', mode: 'managed', enabled: true, watch: true,
    scanning: true, fileCount: 18342, lastScanStartedAt: at('20T08:02'), lastScanFinishedAt: at('19T04:11'),
    lastScanStats: { filesSeen: 18310, filesAdded: 42, filesChanged: 7, filesMissing: 0, errors: 1 },
  },
  {
    id: '00000000-0000-4000-8a00-000000000002', name: 'Vinyl rips', path: '/mnt/archive/vinyl', mode: 'read_only', enabled: true, watch: false,
    scanning: false, fileCount: 2210, lastScanStartedAt: at('19T04:00'), lastScanFinishedAt: at('19T04:06'),
    lastScanStats: { filesSeen: 2210, filesAdded: 0, filesChanged: 0, filesMissing: 3, errors: 0 },
  },
]

/** Live progress for a scanning root, as the `scan.progress` socket event reports it. */
export const scanProgress = { rootId: libraryRoots[0].id, phase: 'probing' as const, processed: 12840, total: 18342 }

export const libraryStats: LibraryStats = {
  artists: 1204, albums: 2310, tracks: 20114, files: 20552, bytes: 812 * 1024 ** 3, durationMs: 1_381_000_000,
  matched: 19210, unmatched: 512, inReview: 14, pending: 378, missing: 3,
}

export const jobs: JobQueueStats[] = [
  { name: 'library.scan', queued: 0, active: 1, failed: 0 },
  { name: 'library.probe', queued: 5502, active: 4, failed: 2 },
  { name: 'library.ingest', queued: 31, active: 1, failed: 0 },
  { name: 'library.analyze', queued: 1840, active: 2, failed: 0 },
  { name: 'matching.match-album', queued: 12, active: 1, failed: 1 },
  { name: 'enrichment.covers', queued: 0, active: 0, failed: 0 },
]

/** The matching and organize contracts are not written yet; these are the shapes the shells assume. */
export const reviews = [
  {
    id: 'r1', folder: '/srv/music/Unsorted/Mira Vale - Blue Hour (2025) [FLAC]', album: albums[0], fileCount: 7,
    candidates: [
      { title: 'Blue Hour (Deluxe)', artist: 'Mira Vale', year: 2025, tracks: 7, country: 'GB', score: 0.86 },
      { title: 'Blue Hour', artist: 'Mira Vale', year: 2025, tracks: 5, country: 'XW', score: 0.71 },
    ],
  },
  {
    id: 'r2', folder: '/srv/music/Downloads/north index - glass city', album: album('glass-city'), fileCount: 4,
    candidates: [{ title: 'Glass City', artist: 'North Index', year: 2026, tracks: 4, country: 'DE', score: 0.82 }],
  },
  {
    id: 'r3', folder: '/srv/music/Unsorted/untitled 04', album: null, fileCount: 11, candidates: [],
  },
]

export const organizeMoves = [
  { from: 'Unsorted/Mira Vale - Blue Hour (2025) [FLAC]/01 night swimming.flac', to: 'Mira Vale/Blue Hour (2025)/1-01 Night Swimming.flac' },
  { from: 'Unsorted/Mira Vale - Blue Hour (2025) [FLAC]/02 soft signal.flac', to: 'Mira Vale/Blue Hour (2025)/1-02 Soft Signal.flac' },
  { from: 'Unsorted/Mira Vale - Blue Hour (2025) [FLAC]/cover.jpg', to: 'Mira Vale/Blue Hour (2025)/cover.jpg' },
  { from: 'Downloads/north index - glass city/track1.mp3', to: 'North Index/Glass City (2026)/01 Static Bloom.mp3' },
  { from: 'Downloads/north index - glass city/track2.mp3', to: 'North Index/Glass City (2026)/02 Fifth Platform.mp3' },
]

export const providers = [
  { id: 'p1', name: 'Cold storage', url: 'http://cold-storage.lan:9300', enabled: true, status: 'healthy', formats: ['flac'], lastCheck: at('20T08:00') },
  { id: 'p2', name: 'Mock provider', url: 'http://127.0.0.1:9400', enabled: false, status: 'disabled', formats: ['flac', 'mp3'], lastCheck: null },
]

export const thisDeviceId = 'web-this-browser'

export const devices: DeviceInfo[] = [
  { id: thisDeviceId, name: 'This browser', kind: 'web', canPlay: true, isActive: true },
  { id: 'phone', name: 'Alex’s iPhone', kind: 'ios', canPlay: true, isActive: false },
  { id: 'living-room', name: 'Living Room', kind: 'other', canPlay: true, isActive: false },
  { id: 'studio-mac', name: 'Studio Mac', kind: 'desktop', canPlay: true, isActive: false },
]
