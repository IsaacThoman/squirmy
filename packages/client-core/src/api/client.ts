import {
  AcquireResponse,
  AcquisitionJobList,
  type AcquisitionJobListQuery,
  AcquisitionPolicy,
  AcquisitionProvider,
  AcquisitionProviderList,
  AlbumDetail,
  AlbumSummary,
  API_PREFIX,
  ApiErrorBody,
  AppPassword,
  AppPasswordList,
  ART_SIZES,
  ArtistDetail,
  ArtistSummary,
  type Artwork,
  AuthResponse,
  CatalogIndexStatus,
  type AddPlaylistItemsRequest,
  type ChangePasswordRequest,
  type ConnectListenBrainzRequest,
  type CreateAppPasswordRequest,
  CreateAcquisitionProviderRequest,
  type CreateImportRequest,
  CreateInviteRequest,
  CreateLibraryRootRequest,
  type CreatePlaylistRequest,
  CreateUserRequest,
  DeviceInfo,
  DirectoryListing,
  type DirectoryQuery,
  GenreSummary,
  HistoryItem,
  HomeResponse,
  Import,
  ImportAlbumList,
  ImportFilesResponse,
  ImportList,
  type ImportListQuery,
  ImportOptions,
  Invite,
  InviteList,
  JobQueueStats,
  LastFmConnectStart,
  type LibraryQuery,
  LibraryRoot,
  LibraryStats,
  type LikeEntityType,
  type LoginRequest,
  Lyrics,
  MatchActionResult,
  MatchCandidateList,
  type MatchCandidatesQuery,
  MatchReviewDetail,
  MatchReviewList,
  type MatchReviewQuery,
  type MovePlaylistItemRequest,
  Ok,
  OrganizeBatch,
  OrganizeBatchAccepted,
  OrganizeBatchList,
  type OrganizeBatchListQuery,
  OrganizePreviewRequest,
  page,
  type Page,
  type PageQuery,
  PlaybackDescriptor,
  type PlaybackQuery,
  PlaylistDetail,
  PlaylistSummary,
  type RegisterRequest,
  RadioResponse,
  type RematchAlbumRequest,
  type ResolveReviewRequest,
  ScanRootResponse,
  SearchResults,
  ScrobblingStatus,
  ServerSettings,
  SessionSnapshot,
  SetupStatus,
  type SetupRequest,
  StartCatalogIndexImport,
  type TrackQuery,
  TrackSummariesResponse,
  type TrackSummariesRequest,
  TrackSummary,
  type UpdateAcquisitionPolicy,
  type UpdateAcquisitionProviderRequest,
  type UpdateLibraryRootRequest,
  type UpdatePlaylistRequest,
  type UpdateServerSettings,
  type UpdateUserRequest,
  type UpdateUserSettings,
  User,
  UserList,
  UserSettings,
  type WantEntityType,
  WantItem,
} from '@squirmy/contracts'
import { z } from 'zod'

/** An `AbortSignal`; client-core is built without the DOM and Node types that declare it. */
export type AbortSignalLike = {
  readonly aborted: boolean
  addEventListener?: (type: 'abort', listener: () => void) => void
}

type ResponseLike = { ok: boolean; status: number; statusText: string; text(): Promise<string> }

/** The subset of `fetch` the client uses. The platform's `fetch` satisfies it. */
export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  credentials: 'include' | 'omit'
  signal?: AbortSignalLike
}) => Promise<ResponseLike>

/** Bytes of a request sent so far. `total` is 0 while the platform does not know it. */
export type UploadProgress = { loaded: number; total: number }

/**
 * Sends a multipart body and reports its progress, which `fetch` cannot. The default uses
 * the platform's `XMLHttpRequest`, which reads `File` and `Blob` parts from disk as it sends.
 */
export type UploadLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  /** A platform `FormData`. */
  body: unknown
  credentials: 'include' | 'omit'
  signal?: AbortSignalLike
  onProgress?: (progress: UploadProgress) => void
}) => Promise<ResponseLike>

/**
 * One file of an upload. `file` is what the platform's `FormData` takes: a browser `File` or
 * `Blob`, or React Native's `{ uri, name, type }`. `relativePath` places it inside the import
 * (`Album/CD1/01 Song.flac`); without one the server uses `name`.
 */
export type UploadFile = { file: unknown; name: string; relativePath?: string }

/** Per-call options of uploads. `onProgress` covers the whole request, every file of it. */
export type UploadOptions = CallOptions & { onProgress?: (progress: UploadProgress) => void }

export type ApiClientOptions = {
  /**
   * The server's root URL, under which `/api/v1` lives, without a trailing slash:
   * `https://music.example.com`, or `''` for same-origin web.
   */
  baseUrl: string
  /**
   * Returns the bearer token of native clients. When it returns a token the request
   * carries `Authorization: Bearer …`; otherwise it is sent with cookies
   * (`credentials: 'include'`).
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike
  /** Defaults to an `XMLHttpRequest`. */
  upload?: UploadLike
  /** Called on every 401 before the `ApiError` is thrown, e.g. to sign out. */
  onUnauthorized?: () => void
  /**
   * Sent as `X-Squirmy-Client`. The web app must send `web`: only then does the server
   * set the session cookie on setup, login and register. Defaults to `client-core`.
   */
  client?: string
  /**
   * Parse responses with the contract schemas, throwing on a mismatch. Defaults to true;
   * production builds pass false (`import.meta.env.DEV`, `__DEV__`).
   */
  validate?: boolean
}

/**
 * Any failed request. `status` is the HTTP status, or 0 when the request never got a
 * response (`code: 'network_error'`). `code` is the server's stable error code.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

type Query = Record<string, string | number | boolean | null | undefined>
type RequestOptions<T> = { query?: Query; body?: unknown; schema: z.ZodType<T>; signal?: AbortSignalLike }
/** Per-call options of the methods that accept them. `signal` aborts the request (it then fails with `network_error`). */
export type CallOptions = { signal?: AbortSignalLike }
/** Request bodies accept the schema's input type, so fields with defaults are optional. */
type Input<T extends z.ZodType> = z.input<T>

const AlbumPage = page(AlbumSummary)
const ArtistPage = page(ArtistSummary)
const TrackPage = page(TrackSummary)
const GenrePage = page(GenreSummary)
const PlaylistPage = page(PlaylistSummary)
const HistoryPage = page(HistoryItem)
const WantPage = page(WantItem)
const RootList = page(LibraryRoot)
const DeviceList = page(DeviceInfo)
const JobList = z.array(JobQueueStats)
const likedPages = { track: TrackPage, album: AlbumPage, artist: ArtistPage } as const
type SearchParams = { q: string; limit?: number }
type LikedItems = { track: TrackSummary; album: AlbumSummary; artist: ArtistSummary }

/**
 * Typed client for the native API, one method per route of the architecture's HTTP
 * table, grouped by module. Every method returns the contract type of the response and
 * throws `ApiError` on failure.
 */
export function createApiClient(options: ApiClientOptions) {
  const base = `${trimSlash(options.baseUrl)}${API_PREFIX}`
  const validate = options.validate ?? true

  async function prepare(json: boolean) {
    const token = await options.getToken?.()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Squirmy-Request': '1',
      'X-Squirmy-Client': options.client ?? 'client-core',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (json) headers['Content-Type'] = 'application/json'
    return { headers, credentials: token ? 'omit' as const : 'include' as const }
  }

  /** Sends one request and turns its answer into the contract type or an `ApiError`. */
  async function call<T>(schema: z.ZodType<T>, perform: () => Promise<ResponseLike>): Promise<T> {
    let response: ResponseLike
    let text: string
    try {
      response = await perform()
      text = await response.text()
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network request failed')
    }

    const json = parseJson(text)
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.()
      const parsed = ApiErrorBody.safeParse(json)
      if (parsed.success) throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details)
      throw new ApiError(response.status, `http_${response.status}`, response.statusText || `HTTP ${response.status}`)
    }
    return validate ? schema.parse(json) : json as T
  }

  async function request<T>(method: string, path: string, { query, body, schema, signal }: RequestOptions<T>): Promise<T> {
    const doFetch = options.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch
    const { headers, credentials } = await prepare(body !== undefined)
    return call(schema, () => doFetch(`${base}${path}${queryString(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials,
      signal,
    }))
  }

  /** `multipart/form-data` with a `relativePath` field before each file that has one. */
  async function upload<T>(path: string, schema: z.ZodType<T>, files: readonly UploadFile[], { signal, onProgress }: UploadOptions): Promise<T> {
    const form = createFormData()
    for (const part of files) {
      if (part.relativePath !== undefined) form.append('relativePath', part.relativePath)
      form.append('file', part.file, part.name)
    }
    const { headers, credentials } = await prepare(false)
    return call(schema, () => (options.upload ?? xhrUpload)(`${base}${path}`, { method: 'POST', headers, body: form, credentials, signal, onProgress }))
  }

  const get = <T>(path: string, schema: z.ZodType<T>, query?: Query, options: CallOptions = {}) => request('GET', path, { schema, query, ...options })
  const send = <T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown) => request(method, path, { schema, body })
  const id = encodeURIComponent

  return {
    auth: {
      setupStatus: () => get('/setup/status', SetupStatus),
      setup: (body: SetupRequest) => send('POST', '/setup', AuthResponse, body),
      login: (body: LoginRequest) => send('POST', '/auth/login', AuthResponse, body),
      logout: () => send('POST', '/auth/logout', Ok),
      register: (body: RegisterRequest) => send('POST', '/auth/register', AuthResponse, body),
      changePassword: (body: ChangePasswordRequest) => send('POST', '/auth/password', Ok, body),
      me: () => get('/auth/me', User),
      appPasswords: () => get('/auth/app-passwords', AppPasswordList),
      /** The response is the only time `secret` is returned. */
      createAppPassword: (body: CreateAppPasswordRequest) => send('POST', '/auth/app-passwords', AppPassword, body),
      deleteAppPassword: (passwordId: string) => send('DELETE', `/auth/app-passwords/${id(passwordId)}`, Ok),
    },
    admin: {
      users: () => get('/admin/users', UserList),
      createUser: (body: Input<typeof CreateUserRequest>) => send('POST', '/admin/users', User, body),
      updateUser: (userId: string, body: UpdateUserRequest) => send('PATCH', `/admin/users/${id(userId)}`, User, body),
      deleteUser: (userId: string) => send('DELETE', `/admin/users/${id(userId)}`, Ok),
      invites: () => get('/admin/invites', InviteList),
      createInvite: (body: Input<typeof CreateInviteRequest> = {}) => send('POST', '/admin/invites', Invite, body),
      deleteInvite: (inviteId: string) => send('DELETE', `/admin/invites/${id(inviteId)}`, Ok),
      settings: () => get('/admin/settings', ServerSettings),
      updateSettings: (body: UpdateServerSettings) => send('PATCH', '/admin/settings', ServerSettings, body),
      jobs: () => get('/admin/jobs', JobList),
      directories: (query: DirectoryQuery = {}) => get('/admin/fs', DirectoryListing, query),
    },
    library: {
      roots: () => get('/admin/library/roots', RootList),
      createRoot: (body: Input<typeof CreateLibraryRootRequest>) => send('POST', '/admin/library/roots', LibraryRoot, body),
      updateRoot: (rootId: string, body: UpdateLibraryRootRequest) => send('PATCH', `/admin/library/roots/${id(rootId)}`, LibraryRoot, body),
      deleteRoot: (rootId: string) => send('DELETE', `/admin/library/roots/${id(rootId)}`, Ok),
      scanRoot: (rootId: string) => send('POST', `/admin/library/roots/${id(rootId)}/scan`, ScanRootResponse),
      stats: () => get('/admin/library/stats', LibraryStats),
    },
    matching: {
      reviews: (query: Partial<MatchReviewQuery> = {}) => get('/admin/reviews', MatchReviewList, query),
      review: (reviewId: string) => get(`/admin/reviews/${id(reviewId)}`, MatchReviewDetail),
      resolveReview: (reviewId: string, body: ResolveReviewRequest) => send('POST', `/admin/reviews/${id(reviewId)}/resolve`, MatchActionResult, body),
      /** Searches MusicBrainz, so it can take several seconds at the public rate limit. */
      candidates: (albumId: string, query: MatchCandidatesQuery = {}) => get(`/admin/albums/${id(albumId)}/candidates`, MatchCandidateList, query),
      /** With a release, applies it and locks the files; without one, queues automatic matching again. */
      rematch: (albumId: string, body: RematchAlbumRequest = {}) => send('POST', `/admin/albums/${id(albumId)}/rematch`, MatchActionResult, body),
      unmatch: (albumId: string) => send('POST', `/admin/albums/${id(albumId)}/unmatch`, MatchActionResult),
    },
    organize: {
      preview: (body: Input<typeof OrganizePreviewRequest>) => send('POST', '/admin/organize/preview', OrganizeBatch, body),
      batches: (query: Partial<OrganizeBatchListQuery> = {}) => get('/admin/organize/batches', OrganizeBatchList, query),
      batch: (batchId: string) => get(`/admin/organize/batches/${id(batchId)}`, OrganizeBatch),
      /** Starts a job; follow it with `batch`. */
      apply: (batchId: string) => send('POST', `/admin/organize/batches/${id(batchId)}/apply`, OrganizeBatchAccepted),
      /** Moves files back. Tags the batch wrote stay written. */
      revert: (batchId: string) => send('POST', `/admin/organize/batches/${id(batchId)}/revert`, OrganizeBatchAccepted),
    },
    catalogIndex: {
      status: () => get('/admin/catalog-index', CatalogIndexStatus),
      startImport: (body: Input<typeof StartCatalogIndexImport> = {}) => send('POST', '/admin/catalog-index/import', Ok, body),
      /** Stops the running import; the index in use stays. */
      cancelImport: () => send('DELETE', '/admin/catalog-index/import', Ok),
      /** Cancels a running import and empties the index. */
      remove: () => send('DELETE', '/admin/catalog-index', Ok),
    },
    catalog: {
      albums: (query: Partial<LibraryQuery> = {}) => get('/library/albums', AlbumPage, query),
      artists: (query: Partial<LibraryQuery> = {}) => get('/library/artists', ArtistPage, query),
      tracks: (query: Partial<LibraryQuery> = {}) => get('/library/tracks', TrackPage, query),
      genres: (query: Partial<PageQuery> = {}) => get('/library/genres', GenrePage, query),
      home: () => get('/home', HomeResponse),
      artist: (artistId: string) => get(`/artists/${id(artistId)}`, ArtistDetail),
      album: (albumId: string) => get(`/albums/${id(albumId)}`, AlbumDetail),
      track: (trackId: string, query: TrackQuery = {}) => get(`/tracks/${id(trackId)}`, TrackSummary, query),
      lyrics: (trackId: string) => get(`/tracks/${id(trackId)}/lyrics`, Lyrics),
      trackSummaries: (body: TrackSummariesRequest) => send('POST', '/tracks/summaries', TrackSummariesResponse, body),
    },
    streaming: {
      playback: (trackId: string, query: Partial<PlaybackQuery> = {}) =>
        get(`/tracks/${id(trackId)}/playback`, PlaybackDescriptor, query),
    },
    userdata: {
      settings: () => get('/me/settings', UserSettings),
      updateSettings: (body: UpdateUserSettings) => send('PATCH', '/me/settings', UserSettings, body),
      like: (type: LikeEntityType, entityId: string) => send('PUT', `/me/likes/${type}/${id(entityId)}`, Ok),
      unlike: (type: LikeEntityType, entityId: string) => send('DELETE', `/me/likes/${type}/${id(entityId)}`, Ok),
      likes: <T extends LikeEntityType>(type: T, query: Partial<PageQuery> = {}) =>
        get(`/me/likes/${type}`, likedPages[type] as unknown as z.ZodType<Page<LikedItems[T]>>, query),
      playlists: (query: Partial<PageQuery> = {}) => get('/playlists', PlaylistPage, query),
      createPlaylist: (body: CreatePlaylistRequest) => send('POST', '/playlists', PlaylistSummary, body),
      playlist: (playlistId: string) => get(`/playlists/${id(playlistId)}`, PlaylistDetail),
      updatePlaylist: (playlistId: string, body: UpdatePlaylistRequest) => send('PATCH', `/playlists/${id(playlistId)}`, PlaylistSummary, body),
      deletePlaylist: (playlistId: string) => send('DELETE', `/playlists/${id(playlistId)}`, Ok),
      addPlaylistItems: (playlistId: string, body: AddPlaylistItemsRequest) =>
        send('POST', `/playlists/${id(playlistId)}/items`, PlaylistDetail, body),
      movePlaylistItem: (playlistId: string, body: MovePlaylistItemRequest) =>
        send('POST', `/playlists/${id(playlistId)}/items/move`, PlaylistDetail, body),
      removePlaylistItem: (playlistId: string, itemId: string) =>
        send('DELETE', `/playlists/${id(playlistId)}/items/${id(itemId)}`, PlaylistDetail),
      history: (query: Partial<PageQuery> = {}) => get('/me/history', HistoryPage, query),
      wants: (query: Partial<PageQuery> = {}) => get('/me/wants', WantPage, query),
      want: (type: WantEntityType, entityId: string) => send('PUT', `/me/wants/${type}/${id(entityId)}`, Ok),
      unwant: (type: WantEntityType, entityId: string) => send('DELETE', `/me/wants/${type}/${id(entityId)}`, Ok),
    },
    sessions: {
      session: () => get('/me/session', SessionSnapshot),
      devices: () => get('/me/devices', DeviceList),
    },
    search: {
      library: (query: SearchParams, options?: CallOptions) => get('/search/library', SearchResults, query, options),
      catalog: (query: SearchParams, options?: CallOptions) => get('/search/catalog', SearchResults, query, options),
    },
    scrobble: {
      status: () => get('/me/scrobbling', ScrobblingStatus),
      connectListenBrainz: (body: ConnectListenBrainzRequest) => send('PUT', '/me/scrobbling/listenbrainz', ScrobblingStatus, body),
      disconnectListenBrainz: () => send('DELETE', '/me/scrobbling/listenbrainz', ScrobblingStatus),
      /** Open the returned `url` in a browser; the server finishes the connection and redirects to `/settings`. */
      startLastFm: () => send('POST', '/me/scrobbling/lastfm/start', LastFmConnectStart),
      disconnectLastFm: () => send('DELETE', '/me/scrobbling/lastfm', ScrobblingStatus),
    },
    imports: {
      /** Whether uploads can start, and their size limits. */
      importOptions: () => get('/imports/options', ImportOptions),
      /** Starts an upload import in `receiving`; fails with `no_managed_root` or `import_root_not_set` without a root to file into. */
      createImport: (body: CreateImportRequest = {}) => send('POST', '/imports', Import, body),
      /**
       * Streams files into a receiving import. A file over the limits ends the request with 413
       * (`file_too_large`, `import_too_large`); the files before it are kept and listed in the
       * error's `details.files`.
       */
      addImportFiles: (importId: string, files: readonly UploadFile[], options: UploadOptions = {}) =>
        upload(`/imports/${id(importId)}/files`, ImportFilesResponse, files, options),
      /** Ends receiving and starts processing; follow it with `getImport` or `import.updated`. */
      commitImport: (importId: string) => send('POST', `/imports/${id(importId)}/commit`, Import),
      getImport: (importId: string) => get(`/imports/${id(importId)}`, Import),
      /** Your own imports, newest first; every import for an admin. */
      listImports: (query: Partial<ImportListQuery> = {}) => get('/imports', ImportList, query),
      importAlbums: (importId: string) => get(`/imports/${id(importId)}/albums`, ImportAlbumList),
      /** Cancels an import that is still receiving. */
      cancelImport: (importId: string) => send('DELETE', `/imports/${id(importId)}`, Import),
    },
    acquisition: {
      listAcquisitionProviders: () => get('/admin/acquisition/providers', AcquisitionProviderList),
      /** Asks the provider for its capabilities right away; an unreachable one is saved with `lastError`. */
      createAcquisitionProvider: (body: Input<typeof CreateAcquisitionProviderRequest>) => send('POST', '/admin/acquisition/providers', AcquisitionProvider, body),
      updateAcquisitionProvider: (providerId: string, body: UpdateAcquisitionProviderRequest) =>
        send('PATCH', `/admin/acquisition/providers/${id(providerId)}`, AcquisitionProvider, body),
      deleteAcquisitionProvider: (providerId: string) => send('DELETE', `/admin/acquisition/providers/${id(providerId)}`, Ok),
      /** Calls the provider's `capabilities`; the answer, or the failure in `lastError`, is on the provider returned. */
      testAcquisitionProvider: (providerId: string) => send('POST', `/admin/acquisition/providers/${id(providerId)}/test`, AcquisitionProvider),
      getAcquisitionPolicy: () => get('/admin/acquisition/policy', AcquisitionPolicy),
      updateAcquisitionPolicy: (body: UpdateAcquisitionPolicy) => send('PATCH', '/admin/acquisition/policy', AcquisitionPolicy, body),
      listAcquisitionJobs: (query: Partial<AcquisitionJobListQuery> = {}) => get('/admin/acquisition/jobs', AcquisitionJobList, query),
      /** Fetches a track on demand; `albumId` names the album it was asked for on. */
      acquireTrack: (trackId: string, query: { albumId?: string } = {}) => request('POST', `/tracks/${id(trackId)}/acquire`, { schema: AcquireResponse, query }),
      /** Fetches an album's missing tracks. */
      acquireAlbum: (albumId: string) => send('POST', `/albums/${id(albumId)}/acquire`, AcquireResponse),
    },
    radio: {
      track: (trackId: string) => send('POST', `/radio/track/${id(trackId)}`, RadioResponse),
      artist: (artistId: string) => send('POST', `/radio/artist/${id(artistId)}`, RadioResponse),
    },
  }
}

/** What `createApiClient` returns. */
export type ApiClient = ReturnType<typeof createApiClient>

/**
 * URL of an artwork rendition, or null without artwork. `size` is the display size in
 * pixels (multiply by the pixel ratio first); the smallest served size at least that
 * large is chosen, or the largest. The route needs no auth.
 */
export function artworkUrl(baseUrl: string, artwork: Artwork | null | undefined, size: number): string | null {
  if (!artwork) return null
  const served = ART_SIZES.find(candidate => candidate >= size) ?? ART_SIZES[ART_SIZES.length - 1]
  return `${trimSlash(baseUrl)}${API_PREFIX}/art/${encodeURIComponent(artwork.id)}/${served}`
}

/** Playable URL of a descriptor: its signed `url` resolved against the server root. */
export function streamUrl(baseUrl: string, descriptor: Pick<PlaybackDescriptor, 'url'>): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(descriptor.url)) return descriptor.url
  return `${trimSlash(baseUrl)}${descriptor.url.startsWith('/') ? '' : '/'}${descriptor.url}`
}

type FormDataLike = { append(name: string, value: unknown, filename?: string): void }

function createFormData(): FormDataLike {
  const FormData = (globalThis as { FormData?: new () => FormDataLike }).FormData
  if (!FormData) throw new Error('Uploads need FormData')
  return new FormData()
}

type XhrLike = {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  withCredentials: boolean
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  status: number
  statusText: string
  responseText: string
  send(body: unknown): void
  abort(): void
}

const xhrUpload: UploadLike = (url, { method, headers, body, credentials, signal, onProgress }) => new Promise((resolve, reject) => {
  const Xhr = (globalThis as { XMLHttpRequest?: new () => XhrLike }).XMLHttpRequest
  if (!Xhr) return reject(new Error('Uploads need XMLHttpRequest'))
  const xhr = new Xhr()
  xhr.open(method, url)
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
  xhr.withCredentials = credentials === 'include'
  xhr.upload.onprogress = event => onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 })
  xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText, text: async () => xhr.responseText })
  xhr.onerror = () => reject(new Error('Network request failed'))
  xhr.onabort = () => reject(new Error('The upload was stopped'))
  if (signal?.aborted) return reject(new Error('The upload was stopped'))
  signal?.addEventListener?.('abort', () => xhr.abort())
  xhr.send(body)
})

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function queryString(query: Query | undefined): string {
  const parts = Object.entries(query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
