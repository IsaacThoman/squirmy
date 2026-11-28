import {
  type LinkSsoRequest,
  type SsoExchangeRequest,
  SsoLinkStart,
  SsoTestResult,
  AccountSecurity,
  Passkey,
  type PasskeyLoginRequest,
  PasskeyOptions,
  type RegisterPasskeyRequest,
  type RenamePasskeyRequest,
  type StartPasskeyRequest,
  AuthSessionList,
  type ConfirmTwoFactorRequest,
  type EnableTwoFactorRequest,
  RecoveryCodes,
  type StartTwoFactorRequest,
  TwoFactorLoginRequest,
  TwoFactorSetup,
  UserSecurity,
  type AcquireQuery,
  AcquireResponse,
  AcquisitionJobList,
  type AcquisitionJobListQuery,
  AcquisitionPolicy,
  AcquisitionProvider,
  AcquisitionProviderList,
  AcquisitionUsage,
  AlbumDetail,
  AlbumPage,
  AlbumSummary,
  API_PREFIX,
  ApiErrorBody,
  AppPassword,
  AppPasswordList,
  ART_SIZES,
  ArtistDetail,
  ArtistPage,
  type ArtistReleasesQuery,
  ArtistSummary,
  type Artwork,
  AuthResponse,
  CatalogIndexStatus,
  ClearProviderMissesResponse,
  type AddPlaylistItemsRequest,
  type ChangePasswordRequest,
  type ConnectListenBrainzRequest,
  type CreateAppPasswordRequest,
  type CreateAcquisitionProviderRequest,
  type CreateImportRequest,
  CreateInviteRequest,
  CreateLibraryRootRequest,
  type CreatePlaylistRequest,
  type CreateShareRequest,
  CreateUserRequest,
  DeviceInfo,
  DuplicatePage,
  type DuplicateQuery,
  HealthPage,
  JamPerson,
  JamPreview,
  QualityPage,
  type RemoveDuplicate,
  type TagEdit,
  TagEditor,
  TagEditResult,
  DirectoryListing,
  type DirectoryQuery,
  GenrePage,
  HistoryPage,
  HistoryImport,
  HistoryImports,
  type HistoryImportSource,
  type ReplayQuery,
  ReplayStats,
  HomeResponse,
  CreateWebhook,
  IntegrationConfig,
  type PlaybackControl,
  type UpdateIntegrationConfig,
  Webhook,
  WebhookDelivery,
  type HomeQuery,
  MixDetail,
  Import,
  ImportAlbumList,
  ImportFilesResponse,
  ImportList,
  type ImportListQuery,
  ImportOptions,
  Invite,
  InviteList,
  JobQueueStats,
  type LastFmConnectRequest,
  LastFmConnectStart,
  LibraryItemPage,
  type LibraryItemsQuery,
  type LibraryQuery,
  LibraryRoot,
  LibraryRootList,
  LibraryStats,
  type LibraryPinKind,
  type LikeEntityType,
  type LikeQuery,
  type LoginRequest,
  Lyrics,
  MatchActionResult,
  MatchCandidateList,
  type MatchCandidatesQuery,
  MatchReviewDetail,
  MatchReviewList,
  type MatchReviewQuery,
  type MovePlaylistItemRequest,
  type RatingRequest,
  Ok,
  PublicShare,
  ShareLink,
  ShareLinkPage,
  ShareTrackPlayback,
  type ShareTrackQuery,
  OrganizeBatch,
  OrganizeBatchAccepted,
  OrganizeBatchList,
  type OrganizeBatchListQuery,
  OrganizePreviewRequest,
  OrganizeTemplateInfo,
  page,
  type Page,
  type PageQuery,
  PlaybackDescriptor,
  type PlaybackQuery,
  PlaylistDetail,
  PlaylistPage,
  PlaylistSummary,
  type RegisterRequest,
  RadioResponse,
  type RematchAlbumRequest,
  type ResolveReviewRequest,
  ScanRootResponse,
  type SearchFacets,
  type SearchResultKind,
  SearchResults,
  ScrobblingStatus,
  ServerSettings,
  SmartPlaylistPreview,
  type SmartPlaylistRules,
  SessionSnapshot,
  SetupStatus,
  type SetupRequest,
  StartCatalogIndexImport,
  type TrackQuery,
  type UpdateAcquisitionPolicy,
  type UpdateAcquisitionProviderRequest,
  TrackSummariesResponse,
  TrackSonic,
  type TrackSummariesRequest,
  TrackPage,
  TrackSummary,
  type UpdateLibraryRootRequest,
  type UpdatePlaylistRequest,
  type UpdateServerSettings,
  type UpdateUserRequest,
  type UpdateUserSettings,
  User,
  UserList,
  UnlikeResponse,
  UserSettings,
  type WantEntityType,
  WantPage,
  type AdminUploadAlbumQuery,
  type AdminUploadsQuery,
  DeleteUploadsResponse,
  UploadAlbumPage,
  UploadFileList,
} from '@squirmy/contracts'
import { z } from 'zod'

/** An `AbortSignal`; client-core is built without the DOM and Node types that declare it. */
export type AbortSignalLike = { readonly aborted: boolean }

/** The subset of `fetch` the client uses. The platform's `fetch` satisfies it. */
export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  credentials: 'include' | 'omit'
  signal?: AbortSignalLike
}) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>

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
  /** Called on every 401 before the `ApiError` is thrown, e.g. to sign out. */
  onUnauthorized?: () => void
  /**
   * Sent as `X-Squirmy-Client`. The web app must send `web`: only then does the server
   * set the session cookie on setup, login and register. Defaults to `client-core`.
   */
  client?: string
  /** For uploads. Default to `globalThis.XMLHttpRequest` and `globalThis.FormData`. */
  xhr?: () => XhrLike
  formData?: () => FormDataLike
  /**
   * Parse responses with the contract schemas, throwing on a mismatch. Defaults to true;
   * production builds pass false (`import.meta.env.DEV`, `__DEV__`).
   */
  validate?: boolean
}

/**
 * The parts of `XMLHttpRequest` an upload uses. Browsers and React Native have it; `fetch`
 * cannot report how much of a request body has been sent.
 */
export type XhrLike = {
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

/** The parts of `FormData` an upload uses. */
export type FormDataLike = { append(name: string, value: unknown, filename?: string): void }

/** One file of an upload. */
export type UploadFile = {
  /** A `File` or `Blob` in browsers, `{ uri, name, type }` in React Native. */
  data: unknown
  name: string
  /** Its path inside the import, such as a dropped folder's `webkitRelativePath`. */
  relativePath?: string
}

export type UploadOptions = {
  /** Bytes of the request sent so far; `total` is null when the platform cannot tell. */
  onProgress?: (progress: { loaded: number; total: number | null }) => void
  /** Aborting it cancels the upload, which then fails with `ApiError` code `aborted`. */
  signal?: AbortSignalLike & { addEventListener(type: 'abort', listener: () => void): void }
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

const DeviceList = page(DeviceInfo)
const JamPeople = page(JamPerson)
const JobList = z.array(JobQueueStats)
const likedPages = { track: TrackPage, album: AlbumPage, artist: ArtistPage } as const
type SearchParams = SearchFacets & { q: string; limit?: number; type?: SearchResultKind; offset?: number; scope?: 'library' | 'server' }
type LikedItems = { track: TrackSummary; album: AlbumSummary; artist: ArtistSummary }

/**
 * Typed client for the native API, one method per route of the architecture's HTTP
 * table, grouped by module. Every method returns the contract type of the response and
 * throws `ApiError` on failure.
 */
export function createApiClient(options: ApiClientOptions) {
  const base = `${trimSlash(options.baseUrl)}${API_PREFIX}`
  const validate = options.validate ?? true

  async function baseHeaders() {
    const token = await options.getToken?.()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Squirmy-Request': '1',
      'X-Squirmy-Client': options.client ?? 'client-core',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return { token, headers }
  }

  /** The response's contract type, or its `ApiError`. */
  function finish<T>(response: { ok: boolean; status: number; statusText: string }, text: string, schema: z.ZodType<T>): T {
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
    const { token, headers } = await baseHeaders()
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Awaited<ReturnType<FetchLike>>
    let text: string
    try {
      response = await doFetch(`${base}${path}${queryString(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: token ? 'omit' : 'include',
        signal,
      })
      text = await response.text()
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network request failed')
    }
    return finish(response, text, schema)
  }

  /**
   * Posts files as `multipart/form-data` through `XMLHttpRequest`, which reports progress.
   * Each file part follows its `relativePath` field when it has one.
   */
  async function upload<T>(path: string, files: readonly UploadFile[], schema: z.ZodType<T>, { onProgress, signal }: UploadOptions = {}): Promise<T> {
    const platform = globalThis as unknown as { XMLHttpRequest?: new () => XhrLike; FormData?: new () => FormDataLike }
    const Xhr = platform.XMLHttpRequest
    const Form = platform.FormData
    const makeXhr = options.xhr ?? (Xhr ? () => new Xhr() : undefined)
    const makeForm = options.formData ?? (Form ? () => new Form() : undefined)
    if (!makeXhr || !makeForm) throw new ApiError(0, 'upload_unavailable', 'This platform cannot upload files')
    const form = makeForm()
    for (const file of files) {
      if (file.relativePath) form.append('relativePath', file.relativePath)
      form.append('file', file.data, file.name)
    }
    const { token, headers } = await baseHeaders()
    if (signal?.aborted) throw new ApiError(0, 'aborted', 'The upload was cancelled')
    const xhr = makeXhr()
    const response = new Promise<{ ok: boolean; status: number; statusText: string; text: string }>((resolve, reject) => {
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText, text: xhr.responseText })
      xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network request failed'))
      xhr.onabort = () => reject(new ApiError(0, 'aborted', 'The upload was cancelled'))
    })
    xhr.open('POST', `${base}${path}`)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.withCredentials = !token
    if (onProgress) xhr.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : null })
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(form)
    const answer = await response
    return finish(answer, answer.text, schema)
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
      /** The second step after `login` answered `two_factor_required`, with the challenge it gave. */
      loginTwoFactor: (body: Input<typeof TwoFactorLoginRequest>) => send('POST', '/auth/login/two-factor', AuthResponse, body),
      sessions: () => get('/auth/sessions', AuthSessionList),
      revokeSession: (sessionId: string) => send('DELETE', `/auth/sessions/${id(sessionId)}`, Ok),
      revokeOtherSessions: () => send('POST', '/auth/sessions/revoke-others', Ok),
      security: () => get('/auth/security', AccountSecurity),
      startTwoFactor: (body: StartTwoFactorRequest) => send('POST', '/auth/two-factor/setup', TwoFactorSetup, body),
      /** The response is the only time the recovery codes are returned. */
      enableTwoFactor: (body: Input<typeof EnableTwoFactorRequest>) => send('POST', '/auth/two-factor/enable', RecoveryCodes, body),
      disableTwoFactor: (body: ConfirmTwoFactorRequest) => send('POST', '/auth/two-factor/disable', Ok, body),
      regenerateRecoveryCodes: (body: ConfirmTwoFactorRequest) => send('POST', '/auth/two-factor/recovery-codes', RecoveryCodes, body),
      /** Creation options for `navigator.credentials.create`, and the challenge to send back with its answer. */
      startPasskey: (body: StartPasskeyRequest) => send('POST', '/auth/passkeys/options', PasskeyOptions, body),
      addPasskey: (body: RegisterPasskeyRequest) => send('POST', '/auth/passkeys', Passkey, body),
      renamePasskey: (passkeyId: string, body: RenamePasskeyRequest) => send('PATCH', `/auth/passkeys/${id(passkeyId)}`, Passkey, body),
      deletePasskey: (passkeyId: string) => send('DELETE', `/auth/passkeys/${id(passkeyId)}`, Ok),
      /** Request options for `navigator.credentials.get`, for any passkey of this server. */
      passkeyLoginOptions: () => send('POST', '/auth/passkey-login/options', PasskeyOptions),
      loginWithPasskey: (body: PasskeyLoginRequest) => send('POST', '/auth/passkey-login', AuthResponse, body),
      /** Where to send the browser to link the single sign-on account; it comes back to `/settings/security`. */
      linkSso: (body: LinkSsoRequest) => send('POST', '/auth/sso/link', SsoLinkStart, body),
      unlinkSso: (identityId: string) => send('DELETE', `/auth/sso/identities/${id(identityId)}`, Ok),
      /** The app's half of single sign-on: the one-time code from `/auth/sso/start`'s redirect. */
      ssoExchange: (body: SsoExchangeRequest) => send('POST', '/auth/sso/exchange', AuthResponse, body),
    },
    admin: {
      duplicates: (query: Partial<DuplicateQuery> = {}) =>
        request('GET', '/admin/library/duplicates', { schema: DuplicatePage, query }),
      removeDuplicate: (fileId: string, body: RemoveDuplicate) =>
        request('DELETE', `/admin/library/duplicates/${id(fileId)}`, { schema: Ok, body }),
      lowQuality: (query: { cursor?: string } = {}) =>
        request('GET', '/admin/library/quality', { schema: QualityPage, query }),
      fileHealth: (query: { cursor?: string; issues?: boolean } = {}) =>
        request('GET', '/admin/library/file-health', { schema: HealthPage, query }),
      recheckFile: (fileId: string) =>
        request('POST', `/admin/library/file-health/${id(fileId)}`, { schema: Ok }),
      albumTags: (albumId: string) =>
        request('GET', `/admin/albums/${id(albumId)}/tags`, { schema: TagEditor }),
      tagCovers: (albumId: string) =>
        request('GET', `/admin/albums/${id(albumId)}/tag-covers`, { schema: TagEditor.shape.covers }),
      editAlbumTags: (albumId: string, body: TagEdit) =>
        request('PATCH', `/admin/albums/${id(albumId)}/tags`, { schema: TagEditResult, body }),
      users: () => get('/admin/users', UserList),
      createUser: (body: Input<typeof CreateUserRequest>) => send('POST', '/admin/users', User, body),
      updateUser: (userId: string, body: UpdateUserRequest) => send('PATCH', `/admin/users/${id(userId)}`, User, body),
      deleteUser: (userId: string) => send('DELETE', `/admin/users/${id(userId)}`, Ok),
      userSecurity: (userId: string) => get(`/admin/users/${id(userId)}/security`, UserSecurity),
      revokeUserSession: (userId: string, sessionId: string) => send('DELETE', `/admin/users/${id(userId)}/sessions/${id(sessionId)}`, Ok),
      revokeUserSessions: (userId: string) => send('DELETE', `/admin/users/${id(userId)}/sessions`, Ok),
      resetTwoFactor: (userId: string) => send('DELETE', `/admin/users/${id(userId)}/two-factor`, Ok),
      testSso: () => send('POST', '/admin/sso/test', SsoTestResult),
      invites: () => get('/admin/invites', InviteList),
      createInvite: (body: Input<typeof CreateInviteRequest> = {}) => send('POST', '/admin/invites', Invite, body),
      deleteInvite: (inviteId: string) => send('DELETE', `/admin/invites/${id(inviteId)}`, Ok),
      settings: () => get('/admin/settings', ServerSettings),
      updateSettings: (body: UpdateServerSettings) => send('PATCH', '/admin/settings', ServerSettings, body),
      jobs: () => get('/admin/jobs', JobList),
      directories: (query: DirectoryQuery = {}) => get('/admin/fs', DirectoryListing, query),
      /** How much the provider cache holds against its limit. */
      acquisitionUsage: () => get('/admin/acquisition/usage', AcquisitionUsage),
    },
    library: {
      roots: () => get('/admin/library/roots', LibraryRootList),
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
      /** The default path template and the tokens a template may use. */
      template: () => get('/admin/organize/template', OrganizeTemplateInfo),
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
      /** The Library's All: albums, artists, playlists and Liked Songs in one list, recently played first by default. */
      items: (query: Partial<LibraryItemsQuery> = {}) => get('/library/items', LibraryItemPage, query),
      albums: (query: Partial<LibraryQuery> = {}) => get('/library/albums', AlbumPage, query),
      artists: (query: Partial<LibraryQuery> = {}) => get('/library/artists', ArtistPage, query),
      tracks: (query: Partial<LibraryQuery> = {}) => get('/library/tracks', TrackPage, query),
      genres: (query: Partial<PageQuery> = {}) => get('/library/genres', GenrePage, query),
      /** The server's albums (its collection), whatever is in the user's library: Home's See all. */
      collectionAlbums: (query: Partial<LibraryQuery> = {}) => get('/collection/albums', AlbumPage, query),
      /** The artists of the server's albums, by name. */
      collectionArtists: (query: Partial<LibraryQuery> = {}) => get('/collection/artists', ArtistPage, query),
      /** The server's songs. */
      collectionTracks: (query: Partial<LibraryQuery> = {}) => get('/collection/tracks', TrackPage, query),
      /** Home's rails; apps of this release ask for `layout: 'personal'` with the device's time zone. */
      home: (query: HomeQuery = {}) => get('/home', HomeResponse, query),
      artist: (artistId: string) => get(`/artists/${id(artistId)}`, ArtistDetail),
      /** One section of an artist page, paged ("See all"). */
      artistReleases: (artistId: string, query: Partial<ArtistReleasesQuery> & Pick<ArtistReleasesQuery, 'section'>) => get(`/artists/${id(artistId)}/releases`, AlbumPage, query),
      album: (albumId: string) => get(`/albums/${id(albumId)}`, AlbumDetail),
      track: (trackId: string, query: TrackQuery = {}) => get(`/tracks/${id(trackId)}`, TrackSummary, query),
      lyrics: (trackId: string) => get(`/tracks/${id(trackId)}/lyrics`, Lyrics),
      /** Tempo, key, energy and per-file timing (for transitions); see `TrackSonic`. */
      sonic: (trackId: string) => get(`/tracks/${id(trackId)}/sonic`, TrackSonic),
      trackSummaries: (body: TrackSummariesRequest) => send('POST', '/tracks/summaries', TrackSummariesResponse, body),
    },
    streaming: {
      playback: (trackId: string, query: Partial<PlaybackQuery> = {}) =>
        get(`/tracks/${id(trackId)}/playback`, PlaybackDescriptor, query),
    },
    userdata: {
      settings: () => get('/me/settings', UserSettings),
      updateSettings: (body: UpdateUserSettings) => send('PATCH', '/me/settings', UserSettings, body),
      /**
       * The heart: saves to your library (the only way in). For a requester the server also
       * fetches what an album or track is missing.
       */
      like: (type: LikeEntityType, entityId: string, query: LikeQuery = {}) =>
        request('PUT', `/me/likes/${type}/${id(entityId)}`, { schema: Ok, query }),
      /**
       * Removes the save only: files and playlists stay. Answers when the save was made; Undo
       * passes it back to `like` so the item returns to its place.
       */
      unlike: (type: LikeEntityType, entityId: string) => send('DELETE', `/me/likes/${type}/${id(entityId)}`, UnlikeResponse),
      /** The user's 1 to 5 stars for a track, album or artist; 0 removes them. */
      rate: (type: LikeEntityType, entityId: string, rating: number) => send('PUT', `/me/ratings/${type}/${id(entityId)}`, Ok, { rating } satisfies RatingRequest),
      likes: <T extends LikeEntityType>(type: T, query: Partial<PageQuery> = {}) =>
        get(`/me/likes/${type}`, likedPages[type] as unknown as z.ZodType<Page<LikedItems[T]>>, query),
      /** Pins an item to the top of the Library's All, on every device; Liked Songs by `LIKED_SONGS_ID`. */
      pin: (kind: LibraryPinKind, entityId: string) => send('PUT', `/me/pins/${kind}/${id(entityId)}`, Ok),
      unpin: (kind: LibraryPinKind, entityId: string) => send('DELETE', `/me/pins/${kind}/${id(entityId)}`, Ok),
      playlists: (query: Partial<PageQuery> = {}) => get('/playlists', PlaylistPage, query),
      createPlaylist: (body: CreatePlaylistRequest) => send('POST', '/playlists', PlaylistSummary, body),
      /** How many songs smart playlist rules find right now, for the rule editor. */
      previewSmartPlaylist: (body: SmartPlaylistRules) => send('POST', '/playlists/smart/preview', SmartPlaylistPreview, body),
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
      replay: (query: Partial<ReplayQuery> = {}) => get('/me/replay', ReplayStats, query),
      historyImports: () => get('/me/history/imports', HistoryImports),
      importHistory: (source: HistoryImportSource, file: UploadFile, options: UploadOptions = {}) =>
        upload(`/me/history/imports?source=${id(source)}`, [file], HistoryImport, options),
      wants: (query: Partial<PageQuery> = {}) => get('/me/wants', WantPage, query),
      want: (type: WantEntityType, entityId: string) => send('PUT', `/me/wants/${type}/${id(entityId)}`, Ok),
      unwant: (type: WantEntityType, entityId: string) => send('DELETE', `/me/wants/${type}/${id(entityId)}`, Ok),
    },
    sessions: {
      session: () => get('/me/session', SessionSnapshot),
      controlPlayback: (body: PlaybackControl) => send('POST', '/me/session/command', SessionSnapshot, body),
      devices: () => get('/me/devices', DeviceList),
      jam: (jamId: string) => get(`/jams/${id(jamId)}`, JamPreview),
      jamPeople: () => get('/jams/people', JamPeople),
    },
    search: {
      library: (query: SearchParams & { genre?: string }, options?: CallOptions) => get('/search/library', SearchResults, query, options),
      catalog: (query: SearchParams, options?: CallOptions) => get('/search/catalog', SearchResults, query, options),
    },
    integrations: {
      personalWebhooks: () => get('/me/webhooks', Webhook.array()),
      createPersonalWebhook: (body: CreateWebhook) => send('POST', '/me/webhooks', Webhook, body),
      deletePersonalWebhook: (id: string) => send('DELETE', `/me/webhooks/${encodeURIComponent(id)}`, Ok),
      testPersonalWebhook: (id: string) => send('POST', `/me/webhooks/${encodeURIComponent(id)}/test`, Ok),
      webhooks: () => get('/admin/webhooks', Webhook.array()),
      createWebhook: (body: CreateWebhook) => send('POST', '/admin/webhooks', Webhook, body),
      deleteWebhook: (id: string) => send('DELETE', `/admin/webhooks/${encodeURIComponent(id)}`, Ok),
      testWebhook: (id: string) => send('POST', `/admin/webhooks/${encodeURIComponent(id)}/test`, Ok),
      deliveries: () => get('/admin/webhook-deliveries', WebhookDelivery.array()),
      config: () => get('/admin/integrations', IntegrationConfig),
      saveConfig: (body: UpdateIntegrationConfig) => send('PUT', '/admin/integrations', IntegrationConfig, body),
    },
    scrobble: {
      status: () => get('/me/scrobbling', ScrobblingStatus),
      connectListenBrainz: (body: ConnectListenBrainzRequest) => send('PUT', '/me/scrobbling/listenbrainz', ScrobblingStatus, body),
      disconnectListenBrainz: () => send('DELETE', '/me/scrobbling/listenbrainz', ScrobblingStatus),
      /**
       * Open the returned `url` in a browser; the server finishes the connection and redirects to
       * `/settings`, or to `returnTo` (an app address, see `lastFmReturnSchemes`).
       */
      startLastFm: (body: LastFmConnectRequest = {}) => send('POST', '/me/scrobbling/lastfm/start', LastFmConnectStart, body),
      disconnectLastFm: () => send('DELETE', '/me/scrobbling/lastfm', ScrobblingStatus),
    },
    radio: {
      track: (trackId: string) => send('POST', `/radio/track/${id(trackId)}`, RadioResponse),
      artist: (artistId: string) => send('POST', `/radio/artist/${id(artistId)}`, RadioResponse),
      /** A mix made for the user, from Home's Made for you. */
      mix: (mixId: string) => get(`/mixes/${id(mixId)}`, MixDetail),
      /** A radio of tracks that sound like this one (falls back to the track radio's mix when it is not analysed). */
      sonic: (trackId: string) => send('POST', `/radio/sonic/${id(trackId)}`, RadioResponse),
    },
    imports: {
      /** Your own imports, or every import for an admin, newest first. */
      list: (query: Partial<ImportListQuery> = {}) => get('/imports', ImportList, query),
      /** Whether uploads can be filed (and why not), and their size limits. */
      options: () => get('/imports/options', ImportOptions),
      create: (body: CreateImportRequest = {}) => send('POST', '/imports', Import, body),
      get: (importId: string) => get(`/imports/${id(importId)}`, Import),
      /** The albums an import's files belong to, and whether each was filed. */
      albums: (importId: string) => get(`/imports/${id(importId)}/albums`, ImportAlbumList),
      /**
       * Uploads files into an import that is receiving; several calls may add to one. A file
       * over the limits fails the request with 413, and the files before it are kept.
       */
      addFiles: (importId: string, files: readonly UploadFile[], options?: UploadOptions) =>
        upload(`/imports/${id(importId)}/files`, files, ImportFilesResponse, options),
      /** Starts processing; follow it with `get` or `import.updated` events. */
      commit: (importId: string) => send('POST', `/imports/${id(importId)}/commit`, Import),
      /** Cancels an import that is still receiving. */
      cancel: (importId: string) => send('DELETE', `/imports/${id(importId)}`, Import),
    },
    uploads: {
      /** The music you uploaded, by album, newest first. */
      list: (query: Partial<PageQuery> = {}) => get('/me/uploads', UploadAlbumPage, query),
      /** Your uploaded files on one album, in track order. */
      album: (albumId: string) => get(`/me/uploads/albums/${id(albumId)}`, UploadFileList),
      /** Deletes your uploaded files on the album from the server, for everyone. Cannot be undone. */
      deleteAlbum: (albumId: string) => send('DELETE', `/me/uploads/albums/${id(albumId)}`, DeleteUploadsResponse),
      /** Deletes one of your uploaded files from the server, for everyone. Cannot be undone. */
      deleteFile: (fileId: string) => send('DELETE', `/me/uploads/files/${id(fileId)}`, DeleteUploadsResponse),
      /** Admins: everyone's uploads, or one uploader's (a user id, or `inbox`). */
      adminList: (query: Partial<AdminUploadsQuery> = {}) => get('/admin/uploads', UploadAlbumPage, query),
      adminAlbum: (albumId: string, query: AdminUploadAlbumQuery = {}) => get(`/admin/uploads/albums/${id(albumId)}`, UploadFileList, query),
      /** Admins: deletes the album's uploaded files (of one uploader, when given) from the server. */
      adminDeleteAlbum: (albumId: string, query: AdminUploadAlbumQuery = {}) =>
        request('DELETE', `/admin/uploads/albums/${id(albumId)}`, { schema: DeleteUploadsResponse, query }),
      adminDeleteFile: (fileId: string) => send('DELETE', `/admin/uploads/files/${id(fileId)}`, DeleteUploadsResponse),
    },
    share: {
      /** Your share links, newest first, expired ones included until they are cleaned up. */
      list: (query: Partial<PageQuery> = {}) => get('/me/shares', ShareLinkPage, query),
      /** The answer's `url` (`/s/<token>`) is the only time the link is returned. */
      create: (body: Input<typeof CreateShareRequest>) => send('POST', '/me/shares', ShareLink, body),
      revoke: (shareId: string) => send('DELETE', `/me/shares/${id(shareId)}`, Ok),
      /** Admins: everyone's links. */
      adminList: (query: Partial<PageQuery> = {}) => get('/admin/shares', ShareLinkPage, query),
      adminRevoke: (shareId: string) => send('DELETE', `/admin/shares/${id(shareId)}`, Ok),
      /** The public page of a link, without a session. 404 `share_not_found` for any link that does not work. */
      page: (token: string) => get(`/share/${id(token)}`, PublicShare),
      /** A short-lived URL for one song of a shared item; resolve it with `streamUrl`. */
      trackPlayback: (token: string, trackId: string, query: ShareTrackQuery = {}) =>
        get(`/share/${id(token)}/tracks/${id(trackId)}/playback`, ShareTrackPlayback, query),
    },
    acquisition: {
      providers: () => get('/admin/acquisition/providers', AcquisitionProviderList),
      /** Calls the provider's `capabilities` straight away. The secret is never returned. */
      createProvider: (body: Input<typeof CreateAcquisitionProviderRequest>) => send('POST', '/admin/acquisition/providers', AcquisitionProvider, body),
      updateProvider: (providerId: string, body: UpdateAcquisitionProviderRequest) =>
        send('PATCH', `/admin/acquisition/providers/${id(providerId)}`, AcquisitionProvider, body),
      deleteProvider: (providerId: string) => send('DELETE', `/admin/acquisition/providers/${id(providerId)}`, Ok),
      /** Calls `capabilities` again and records the answer or the error. */
      testProvider: (providerId: string) => send('POST', `/admin/acquisition/providers/${id(providerId)}/test`, AcquisitionProvider),
      /** "Retry unavailable tracks": the provider's misses stop counting, so its tracks are asked for again. */
      clearProviderMisses: (providerId: string) =>
        send('POST', `/admin/acquisition/providers/${id(providerId)}/clear-misses`, ClearProviderMissesResponse),
      policy: () => get('/admin/acquisition/policy', AcquisitionPolicy),
      updatePolicy: (body: UpdateAcquisitionPolicy) => send('PATCH', '/admin/acquisition/policy', AcquisitionPolicy, body),
      jobs: (query: Partial<AcquisitionJobListQuery> = {}) => get('/admin/acquisition/jobs', AcquisitionJobList, query),
      /** Fetches a track the server lacks. Playing one does this by itself. */
      acquireTrack: (trackId: string, query: AcquireQuery = {}) => request('POST', `/tracks/${id(trackId)}/acquire`, { schema: AcquireResponse, query }),
      acquireAlbum: (albumId: string, query: Omit<AcquireQuery, 'albumId'> = {}) =>
        request('POST', `/albums/${id(albumId)}/acquire`, { schema: AcquireResponse, query }),
    },
  }
}

/** What `createApiClient` returns. */
export type ApiClient = ReturnType<typeof createApiClient>

/**
 * URL of an artwork rendition, or null without artwork. `size` is the display size in
 * pixels (multiply by the pixel ratio first); the smallest served size at least that
 * large is chosen, or the largest. The route needs no auth. The extension lets a CDN in
 * front of the server cache renditions (Cloudflare caches by extension).
 */
export function artworkUrl(baseUrl: string, artwork: Artwork | null | undefined, size: number): string | null {
  if (!artwork) return null
  const served = ART_SIZES.find(candidate => candidate >= size) ?? ART_SIZES[ART_SIZES.length - 1]
  return `${trimSlash(baseUrl)}${API_PREFIX}/art/${encodeURIComponent(artwork.id)}/${served}.webp`
}

/** Playable URL of a descriptor: its signed `url` resolved against the server root. */
export function streamUrl(baseUrl: string, descriptor: Pick<PlaybackDescriptor, 'url'>): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(descriptor.url)) return descriptor.url
  return `${trimSlash(baseUrl)}${descriptor.url.startsWith('/') ? '' : '/'}${descriptor.url}`
}

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
