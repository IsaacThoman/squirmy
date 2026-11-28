import { ApiError, createInitialSession, diffQueue, queueChanged, queueLengths, reduceSession, splitSession, type AnySessionCommand, type ApiClient, type Session } from '@squirmy/client-core'
import type { SquirmySocket } from '@squirmy/client-core/socket'
import {
  DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TEMPLATE_TOKENS,
  type AcquisitionPolicy, type AlbumPage, type CommandEnvelope, type DeviceInfo, type Import, type LibraryItemPage, type LibraryRoot, type LibraryStats, type OrganizeTemplateInfo, type PlaylistSummary,
  type ScrobblingStatus, type SearchKind, type SessionHello, type SetupStatus, type TrackSummariesRequest, type UploadAlbum, type UploadFile, type User, type WantItem,
} from '@squirmy/contracts'
import { vi } from 'vitest'
import type { Services } from '@/api/services'
import {
  albumDetail, allTracks, artistDetail, genres, home, libraryAlbums, mixDetail, libraryArtists, libraryTracks, likedTracks, lyricsFor, playlistDetail, playlistSummaries,
  searchFixtures, searchPage, wantlist,
} from '@/fixtures/catalog'
import { appPasswords, currentUser, invites, jobs, serverSettings, userSettings, users } from '@/fixtures/server'

type Listener = (...args: never[]) => void

type Ack = (error: Error | null, reply?: unknown) => void

class ManagerStub {
  private readonly listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  /** As socket.io's manager does when the server pings. */
  serverEmit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as () => void)()
  }
}

/**
 * Enough of a socket.io socket for the realtime provider and the session client: events can
 * be fired at it with `serverEmit`, and it answers the session protocol with the real
 * reducer, as the server would for one device.
 */
export class FakeSocket {
  connected = false
  active = false
  session = createInitialSession()
  version = 1
  queueVersion = 1
  /** The app's hello accepted `queueOps`: queue changes go to it as operations, as the server sends them. */
  private acceptsOps = false
  /** The queue before each queue edit, by command id, for `undo`: the real server puts back by id; going back whole is enough here. */
  private readonly undoable = new Map<string, Session>()
  private devices: DeviceInfo[] = []
  private deviceId: string | undefined
  private readonly listeners = new Map<string, Set<Listener>>()
  /** The manager: its `ping` is what the provider counts as hearing from the server. */
  readonly io = new ManagerStub()

  timeout() {
    return { emit: (event: string, payload: unknown, ack: Ack) => queueMicrotask(() => this.answer(event, payload, ack)) }
  }

  /** Every session command the app sent, in order, for tests that check what a button asked. */
  commands: AnySessionCommand[] = []

  /** Engine reports; nothing to answer. */
  emit() {
    return this
  }

  private answer(event: string, payload: unknown, ack: Ack) {
    if (event === 'session:hello') {
      const { device, canPlay, accepts } = payload as SessionHello
      this.deviceId = device.id
      this.devices = [{ ...device, canPlay, isActive: false }]
      this.acceptsOps = accepts?.includes('queueOps') ?? false
      return ack(null, { serverTime: Date.now(), snapshot: this.snapshot(), devices: this.devices, capabilities: ['queueOps', 'undo'] })
    }
    if (event === 'time:sync') return ack(null, { clientTime: payload, serverTime: Date.now() })
    if (event === 'session:sync') return ack(null, { ok: true, snapshot: this.snapshot() })
    const { command, commandId } = payload as CommandEnvelope
    this.commands.push(command)
    if (command.type === 'undo') {
      const before = this.undoable.get(command.commandId)
      this.undoable.delete(command.commandId)
      if (!before) return ack(null, { ok: false, error: 'nothing_to_undo' })
      ack(null, { ok: true, version: this.version + 1 })
      return this.commit({ ...this.session, queue: before.queue, autoplayQueue: before.autoplayQueue, playOrder: before.playOrder })
    }
    const next = reduceSession(this.session, { command, now: Date.now(), commandId, deviceId: this.deviceId })
    if (next !== this.session && ['removeFromQueue', 'enqueue', 'moveInQueue', 'clearQueue'].includes(command.type)) this.undoable.set(commandId, this.session)
    ack(null, { ok: true, version: this.version + (next === this.session ? 0 : 1) })
    this.commit(next)
  }

  /** A change the server makes on its own, such as a fetch that failed (`setEntryState`), told to the device. */
  serverApply(command: AnySessionCommand) {
    this.commit(reduceSession(this.session, { command, now: Date.now(), commandId: `server-${this.version}` }))
  }

  /** Replaces the session as the server would, for changes no command makes (pausing on a failure in a row). */
  serverSet(edit: (session: Session) => Session) {
    this.commit(edit(this.session))
  }

  private snapshot() {
    const { state, queue } = splitSession(this.session)
    return { version: this.version, queueVersion: this.queueVersion, state, queue, scope: { type: 'shared' as const } }
  }

  private commit(next: Session) {
    const previous = this.session
    if (next === previous) return
    this.session = next
    this.version += 1
    const { state, queue } = splitSession(next)
    if (queueChanged(previous, next)) {
      this.queueVersion += 1
      const ops = this.acceptsOps ? diffQueue(splitSession(previous).queue, queue) : null
      if (ops) {
        const baseQueueVersion = this.queueVersion - 1
        this.serverEmit('session:queueOps', { version: this.version, queueVersion: this.queueVersion, baseQueueVersion, scope: { type: 'shared' }, lengths: queueLengths(queue), ops })
      } else {
        this.serverEmit('session:queue', { version: this.version, queueVersion: this.queueVersion, queue })
      }
    }
    this.serverEmit('session:state', { version: this.version, state })
  }

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  connect() {
    this.active = true
    this.connected = true
    this.serverEmit('connect')
    return this
  }

  disconnect() {
    this.active = false
    if (this.connected) {
      this.connected = false
      this.serverEmit('disconnect', 'io client disconnect')
    }
    return this
  }

  /** Delivers an event as if the server (or socket.io itself) sent it. */
  serverEmit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as (...values: unknown[]) => void)(...args)
  }
}

type SearchParams = { q: string; limit?: number; type?: SearchKind; offset?: number }
const list = <T>(items: T[]) => ({ items, nextCursor: null as string | null })
const ok = { ok: true as const }
const notFound = () => new ApiError(404, 'not_found', 'Not found')
const found = <T>(value: T | null | undefined): T => {
  if (value == null) throw notFound()
  return value
}
const wants: WantItem[] = [
  ...wantlist.albums.map(album => ({ type: 'album' as const, album, wantedAt: '2026-11-18T10:00:00.000Z', fulfilledAt: null })),
  ...wantlist.tracks.map(track => ({ type: 'track' as const, track, wantedAt: '2026-11-18T10:00:00.000Z', fulfilledAt: null })),
]
const scrobbling: ScrobblingStatus = {
  services: [
    { target: 'listenbrainz', available: true, connected: true, account: 'alex', enabled: true, needsAttention: false, lastError: null, connectedAt: '2026-11-02T09:12:00.000Z', pending: 2, failed: 0 },
    { target: 'lastfm', available: false, connected: false, account: null, enabled: false, needsAttention: false, lastError: null, connectedAt: null, pending: 0, failed: 0 },
  ],
}

export const templateInfo: OrganizeTemplateInfo = {
  defaultTemplate: DEFAULT_ORGANIZE_TEMPLATE,
  tokens: ORGANIZE_TEMPLATE_TOKENS.map(token => ({ token, description: token === 'album' ? 'The album title' : `The ${token}` })),
}

export const root: LibraryRoot = {
  id: '00000000-0000-4000-8900-000000000001', name: 'Music', path: '/srv/music', mode: 'read_only', enabled: true, watch: true, template: null, scanning: false,
  fileCount: 120, lastScanStartedAt: '2026-11-20T10:00:00.000Z', lastScanFinishedAt: '2026-11-20T10:02:00.000Z',
  lastScanStats: { filesSeen: 120, filesAdded: 120, filesChanged: 0, filesMissing: 0, errors: 0 },
}

export const upload: Import = {
  id: '00000000-0000-4000-8a00-000000000001', kind: 'upload', status: 'completed', step: null, label: 'Blue Hour', userId: currentUser.id, acquisitionJobId: null,
  targetRootId: root.id, timedOut: false, reviewFolder: null, error: null,
  counts: {
    filesReceived: 5, bytesReceived: 2e7, filesRejected: 0, filesExtracted: 0, archivesRejected: 0, audioFiles: 5, duplicatesSkipped: 0, unreadable: 0,
    albumsIdentified: 1, albumsFiled: 1, filesFiled: 5, filesLeftForReview: 0,
  },
  createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:02:00.000Z', completedAt: '2026-11-20T10:02:00.000Z',
}

/** One album the fixture admin uploaded, and its two songs. */
export const uploadAlbum: UploadAlbum = {
  album: libraryAlbums[0]!,
  uploader: { id: currentUser.id, username: currentUser.username, displayName: currentUser.displayName },
  fileCount: 2, bytes: 20 * 1024 ** 2, uploadedAt: '2026-11-20T10:02:00.000Z',
}
export const uploadFiles: UploadFile[] = libraryTracks.slice(0, 2).map((track, index) => ({
  fileId: `00000000-0000-4000-8b00-00000000000${index + 1}`, track, title: track.title, uploader: uploadAlbum.uploader,
  codec: 'flac', bytes: 10 * 1024 ** 2, durationMs: track.durationMs, uploadedAt: uploadAlbum.uploadedAt,
}))

const policy: AcquisitionPolicy = { preferLossless: true, maxFileBytes: 5e8, storageQuotaBytes: 0, timeoutSeconds: 900, targetRootId: null, deliveryBaseUrl: null }

const stats: LibraryStats = { artists: 9, albums: 12, tracks: 118, files: 120, bytes: 4e8, durationMs: 3e7, matched: 100, unmatched: 8, inReview: 12, pending: 0, missing: 0 }

export type FakeOptions = { status?: Partial<SetupStatus>; user?: User | null }

/** An API answering from the fixtures, signed in as the fixture admin unless told otherwise. Every method is a mock. */
export function fakeServices({ status, user = currentUser }: FakeOptions = {}) {
  const socket = new FakeSocket()
  const api = {
    auth: {
      setupStatus: vi.fn(async () => ({ needsSetup: false, version: '0.0.0', serverName: 'Squirmy', registrationRequiresInvite: true, wantlistEnabled: true, ...status })),
      me: vi.fn(async () => {
        if (user) return user
        throw new ApiError(401, 'unauthorized', 'Sign in to continue')
      }),
      login: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      register: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      setup: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      logout: vi.fn(async () => ({ ok: true as const })),
      changePassword: vi.fn(async () => ({ ok: true as const })),
      appPasswords: vi.fn(async () => list(appPasswords)),
      createAppPassword: vi.fn(async ({ name }: { name: string }) => ({ ...appPasswords[0], name, secret: 'sq-secret' })),
      deleteAppPassword: vi.fn(async () => ({ ok: true as const })),
    },
    admin: {
      users: vi.fn(async () => list(users)),
      createUser: vi.fn(async () => users[1]),
      updateUser: vi.fn(async (id: string, patch: Partial<User>) => ({ ...users.find(candidate => candidate.id === id)!, ...patch })),
      deleteUser: vi.fn(async () => ({ ok: true as const })),
      invites: vi.fn(async () => list(invites)),
      createInvite: vi.fn(async () => invites[0]),
      deleteInvite: vi.fn(async () => ({ ok: true as const })),
      settings: vi.fn(async () => serverSettings),
      updateSettings: vi.fn(async (patch: object) => ({ ...serverSettings, ...patch })),
      jobs: vi.fn(async () => jobs),
      directories: vi.fn(async ({ path }: { path?: string } = {}) => ({
        path: path ?? '/home/alex', parent: '/home', directories: [{ name: 'Music', path: `${path ?? '/home/alex'}/Music` }],
      })),
    },
    library: {
      roots: vi.fn(async () => list([root])),
      createRoot: vi.fn(async (request: { name: string; path: string }) => ({ ...root, ...request })),
      updateRoot: vi.fn(async (_id: string, patch: object) => ({ ...root, ...patch })),
      deleteRoot: vi.fn(async () => ({ ok: true as const })),
      scanRoot: vi.fn(async () => ({ queued: true })),
      stats: vi.fn(async () => stats),
    },
    matching: {
      reviews: vi.fn(async () => list([])),
    },
    organize: {
      template: vi.fn(async () => templateInfo),
      batches: vi.fn(async () => list([])),
    },
    catalogIndex: {
      status: vi.fn(async () => ({
        ready: false, dumpDate: null, importedAt: null, counts: { artists: 0, albums: 0, recordings: 0 }, sizeBytes: 0, active: null, latest: null,
      })),
    },
    catalog: {
      home: vi.fn(async () => home),
      // All, as the server lists it before anything is played: the newest first, which here is fixture order.
      items: vi.fn(async (): Promise<LibraryItemPage> => list([
        { kind: 'liked' as const, playedAt: null },
        ...playlistSummaries.map(playlist => ({ kind: 'playlist' as const, playlist: { ...playlist, ownerId: currentUser.id }, playedAt: null })),
        ...libraryAlbums.map(album => ({ kind: 'album' as const, album, playedAt: null })),
        ...libraryArtists.map(artist => ({ kind: 'artist' as const, artist, playedAt: null })),
      ])),
      albums: vi.fn(async () => list(libraryAlbums)),
      artists: vi.fn(async () => list(libraryArtists)),
      tracks: vi.fn(async () => list(libraryTracks)),
      collectionAlbums: vi.fn(async () => list(libraryAlbums)),
      collectionArtists: vi.fn(async () => list(libraryArtists)),
      collectionTracks: vi.fn(async () => list(libraryTracks)),
      genres: vi.fn(async () => list(genres.map(genre => ({ name: genre.name, albumCount: 1 })))),
      album: vi.fn(async (id: string) => found(albumDetail(id))),
      artist: vi.fn(async (id: string) => found(artistDetail(id))),
      artistReleases: vi.fn(async (id: string, { section }: { section: string; cursor?: string }): Promise<AlbumPage> => list(found(artistDetail(id)).sections?.find(item => item.key === section)?.items ?? [])),
      track: vi.fn(async (id: string) => found(allTracks.find(track => track.id === id))),
      lyrics: vi.fn(async (id: string) => found(lyricsFor(id))),
      trackSummaries: vi.fn(async ({ tracks }: TrackSummariesRequest) => ({ tracks: tracks.flatMap(({ id }) => allTracks.filter(track => track.id === id).slice(0, 1)) })),
    },
    streaming: {
      // No audio in tests: a failure that may pass, which the session client retries. A test of a
      // refused track makes it a 404.
      playback: vi.fn(async (): Promise<never> => {
        throw new Error('No audio in tests')
      }),
    },
    userdata: {
      settings: vi.fn(async () => userSettings),
      updateSettings: vi.fn(async (patch: object) => ({ ...userSettings, ...patch })),
      likes: vi.fn(async () => list(likedTracks)),
      like: vi.fn(async () => ok),
      unlike: vi.fn(async (): Promise<{ ok: true; savedAt: string | null }> => ({ ok: true, savedAt: null })),
      playlists: vi.fn(async () => list(playlistSummaries.map(playlist => ({ ...playlist, ownerId: currentUser.id })))),
      playlist: vi.fn(async (id: string) => ({ ...found(playlistDetail(id)), ownerId: currentUser.id })),
      createPlaylist: vi.fn(async ({ name }: { name: string }): Promise<PlaylistSummary> => ({ ...playlistSummaries[0], id: '00000000-0000-4000-8400-0000000000ff', name, trackCount: 0 })),
      wants: vi.fn(async () => list(wants)),
      want: vi.fn(async () => ok),
      unwant: vi.fn(async () => ok),
      pin: vi.fn(async () => ok),
      unpin: vi.fn(async () => ok),
    },
    search: {
      library: vi.fn(async (params: SearchParams & { genre?: string }) => searchPage(searchFixtures(params.q).library, params)),
      catalog: vi.fn(async (params: SearchParams) => searchPage(searchFixtures(params.q).catalog, params)),
    },
    scrobble: {
      status: vi.fn(async () => scrobbling),
    },
    imports: {
      options: vi.fn(async () => ({ unavailable: null, maxFileBytes: 4 * 1024 ** 3, maxBytes: 64 * 1024 ** 3 })),
      list: vi.fn(async () => list([upload])),
      get: vi.fn(async (id: string) => (id === upload.id ? upload : found(null))),
      albums: vi.fn(async () => list([{ album: libraryAlbums[0], files: 5, filed: true }])),
      cancel: vi.fn(async () => ({ ...upload, status: 'failed', error: 'Cancelled' })),
    },
    uploads: {
      list: vi.fn(async () => list([uploadAlbum])),
      album: vi.fn(async () => list(uploadFiles)),
      deleteAlbum: vi.fn(async () => ({ deletedFiles: 2, deletedBytes: 20 * 1024 ** 2, keptFiles: 0 })),
      deleteFile: vi.fn(async () => ({ deletedFiles: 1, deletedBytes: 10 * 1024 ** 2, keptFiles: 0 })),
      adminList: vi.fn(async () => list([uploadAlbum, { ...uploadAlbum, uploader: null }])),
      adminAlbum: vi.fn(async () => list(uploadFiles)),
      adminDeleteAlbum: vi.fn(async () => ({ deletedFiles: 2, deletedBytes: 20 * 1024 ** 2, keptFiles: 0 })),
      adminDeleteFile: vi.fn(async () => ({ deletedFiles: 1, deletedBytes: 10 * 1024 ** 2, keptFiles: 0 })),
    },
    radio: {
      mix: vi.fn(async (id: string) => found(mixDetail(id))),
      track: vi.fn(async (id: string) => ({ context: { type: 'radio' as const, id: `track:${id}`, title: null }, tracks: [{ trackId: id, durationMs: 1000 }] })),
      artist: vi.fn(async (id: string) => ({ context: { type: 'radio' as const, id: `artist:${id}`, title: null }, tracks: libraryTracks.slice(0, 3).map(item => ({ trackId: item.id, durationMs: item.durationMs })) })),
    },
    acquisition: {
      providers: vi.fn(async () => list([])),
      policy: vi.fn(async () => policy),
      jobs: vi.fn(async () => list([])),
      acquireAlbum: vi.fn(async () => list([])),
    },
  }
  const services: Services = { api: api as unknown as ApiClient, createSocket: () => socket as unknown as SquirmySocket }
  return { services, api, socket }
}
