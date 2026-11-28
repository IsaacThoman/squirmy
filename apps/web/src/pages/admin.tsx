import {
  AcquisitionJobStatus, MatchReviewStatus, queryKeys,
  type AcquisitionPolicy, type AcquisitionProvider, type CatalogIndexStatus, type LibraryRoot, type MatchReview, type OrganizeBatchSummary, type ResolveReviewRequest,
  type ServerSettings, type UpdateAcquisitionPolicy, type UpdateAcquisitionProviderRequest, type UpdateLibraryRootRequest, type UpdateServerSettings, type User,
  type UpdateUserRequest,
} from '@squirmy/contracts'
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useFolderListing } from '@/api/folders'
import { importsKey } from '@/api/queries'
import { useApi } from '@/api/services'
import { setupStatusKey, useCurrentUser, useSetupStatus } from '@/auth/session'
import { AdminLayout as AdminFrame } from '@/components/admin/AdminLayout'
import { FindAlbumDialog } from '@/components/admin/FindAlbumDialog'
import { FixMatch } from '@/components/admin/FixMatch'
import { JobsAdmin, LibraryAdmin, type ScanProgress } from '@/components/admin/LibraryAdmin'
import { OrganizeAdmin, type OrganizeOptions } from '@/components/admin/OrganizeAdmin'
import { ProvidersAdmin } from '@/components/admin/ProvidersAdmin'
import { ReviewAdmin } from '@/components/admin/ReviewAdmin'
import { SearchIndexAdmin } from '@/components/admin/SearchIndexAdmin'
import { ServerSettingsAdmin } from '@/components/admin/ServerSettingsAdmin'
import { UsersAdmin } from '@/components/admin/UsersAdmin'
import { loadFailure } from '@/components/ui/load-failure'
import { useServerEvent } from '@/realtime/realtime-context'

const invitesKey = [...queryKeys.admin(), 'invites'] as const
const settingsKey = [...queryKeys.admin(), 'settings'] as const
// Under `library` so ingest and matching, which invalidate it, refresh the numbers too.
const statsKey = [...queryKeys.library(), 'stats'] as const
const reviewsKey = (status: MatchReviewStatus) => [...queryKeys.adminReviews(), 'list', status] as const
const reviewKey = (id: string | null) => [...queryKeys.adminReviews(), 'detail', id] as const
const batchesKey = [...queryKeys.adminOrganize(), 'batches'] as const
const batchKey = (id: string | null) => [...queryKeys.adminOrganize(), 'batch', id] as const
const catalogIndexKey = [...queryKeys.admin(), 'catalog-index'] as const
const acquisitionKey = [...queryKeys.admin(), 'acquisition'] as const
const providersKey = [...acquisitionKey, 'providers'] as const
const policyKey = [...acquisitionKey, 'policy'] as const
const acquisitionJobsKey = [...acquisitionKey, 'jobs'] as const
const usageKey = [...acquisitionKey, 'usage'] as const
const JOBS_REFRESH_MS = 3000
/** Requests come a page at a time, newest first; older ones load on asking. */
const REQUESTS_PAGE = 100
// Organize jobs and index imports report progress only in the database, so their screens poll while one runs.
const RUNNING_REFRESH_MS = 1500
function useOpenReviewCount(): number | undefined {
  const api = useApi()
  return useQuery({
    queryKey: reviewsKey('open'),
    queryFn: () => api.matching.reviews({ status: 'open', limit: 100 }),
    select: page => page.items.length,
  }).data
}

function useRoots() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.adminRoots(), queryFn: () => api.library.roots(), select: page => page.items })
}

/** The default naming template and its tokens; they only change with the server. */
function useTemplateInfo() {
  const api = useApi()
  return useQuery({ queryKey: [...queryKeys.adminOrganize(), 'template'], queryFn: () => api.organize.template(), staleTime: Infinity }).data
}

const managedOnly = (roots: LibraryRoot[] | undefined) => roots?.filter(root => root.mode === 'managed' && root.enabled)

export function AdminLayout() {
  return <AdminFrame counts={{ '/admin/reviews': useOpenReviewCount() }} version={useSetupStatus().data?.version} />
}

/** "Fix match" from anywhere in admin: the album search, then the dialog for the album picked. */
function useFixMatch() {
  const api = useApi()
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [albumId, setAlbumId] = useState<string | null>(null)
  const q = query.trim()
  const results = useQuery({
    queryKey: [...queryKeys.search(), 'library', q],
    queryFn: () => api.search.library({ q, limit: 12, scope: 'server' }),
    enabled: finding && !!q,
    placeholderData: keepPreviousData,
  })
  const dialogs = (
    <>
      <FindAlbumDialog
        open={finding}
        onOpenChange={setFinding}
        query={query}
        onQueryChange={setQuery}
        albums={q ? results.data?.albums : undefined}
        failure={loadFailure(results, 'The search did not answer')}
        onPick={album => {
          setFinding(false)
          setAlbumId(album.id)
        }}
      />
      {albumId && <FixMatch albumId={albumId} onOpenChange={open => { if (!open) setAlbumId(null) }} />}
    </>
  )
  return { find: () => setFinding(true), open: setAlbumId, dialogs }
}

export function AdminLibraryPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const roots = useRoots()
  const templateInfo = useTemplateInfo()
  const [params, setParams] = useSearchParams()
  const stats = useQuery({ queryKey: statsKey, queryFn: () => api.library.stats() })
  const cache = useQuery({ queryKey: usageKey, queryFn: () => api.admin.acquisitionUsage() })
  const openReviews = useOpenReviewCount()
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({})
  const [browsePath, setBrowsePath] = useState<string>()
  const listing = useFolderListing(browsePath)
  const fixMatch = useFixMatch()
  const refresh = () => Promise.all([queryKeys.adminRoots(), statsKey].map(queryKey => queryClient.invalidateQueries({ queryKey })))

  useServerEvent('scan.progress', event => {
    setProgress(current => ({ ...current, [event.rootId]: event }))
    // Scans end quietly for the stats: refresh them when a phase finishes.
    if (event.phase === 'idle' || (event.phase !== 'discovering' && event.processed >= event.total)) void queryClient.invalidateQueries({ queryKey: statsKey })
  })

  // Each action's failure is said where it was asked for: the folder's row, or its dialog. A
  // folder added, scanning or removed shows in the list, so only a scan already running is said.
  const scan = useMutation({ mutationFn: api.library.scanRoot, onSuccess: refresh })
  const add = useMutation({ mutationFn: api.library.createRoot, onSuccess: refresh })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLibraryRootRequest }) => api.library.updateRoot(id, patch),
    onSuccess: (root: LibraryRoot) => {
      queryClient.setQueryData(queryKeys.adminRoots(), (page: { items: LibraryRoot[] } | undefined) => page && { ...page, items: page.items.map(item => item.id === root.id ? root : item) })
      return refresh()
    },
  })
  const remove = useMutation({ mutationFn: api.library.deleteRoot, onSuccess: refresh })
  return (
    <>
      <LibraryAdmin
        roots={roots.data}
        stats={stats.data}
        cache={cache.data}
        openReviews={openReviews}
        progress={progress}
        templateInfo={templateInfo}
        editRootId={params.get('edit')}
        onEditorClosed={() => setParams({}, { replace: true })}
        folders={{ path: listing.data?.path ?? browsePath, listing: listing.data, error: listing.isError ? errorMessage(listing.error) : undefined, onBrowse: setBrowsePath }}
        onScan={id => scan.mutateAsync(id)}
        onAdd={request => add.mutateAsync(request)}
        onUpdate={(id, patch) => update.mutateAsync({ id, patch })}
        onRemove={id => remove.mutateAsync(id)}
        onFixMatch={fixMatch.find}
        failures={{ roots: loadFailure(roots, 'The folders did not load'), stats: loadFailure(stats, 'The library’s numbers did not load') }}
      />
      {fixMatch.dialogs}
    </>
  )
}

export function AdminReviewsPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const status = MatchReviewStatus.safeParse(params.get('status')).data ?? 'open'
  const selectedId = params.get('review')
  const roots = useRoots()
  const reviews = useQuery({ queryKey: reviewsKey(status), queryFn: () => api.matching.reviews({ status, limit: 100 }) })
  const detail = useQuery({ queryKey: reviewKey(selectedId), queryFn: () => api.matching.review(selectedId!), enabled: !!selectedId })
  const fixMatch = useFixMatch()
  const go = (next: { status?: MatchReviewStatus; review?: string | null }) => setParams(current => {
    const updated = new URLSearchParams(current)
    if (next.status) updated.set('status', next.status)
    if (next.review) updated.set('review', next.review)
    else if (next.review === null || next.status) updated.delete('review')
    return updated
  })
  const resolve = useMutation({
    mutationFn: ({ review, request }: { review: MatchReview; request: ResolveReviewRequest }) => api.matching.resolveReview(review.id, request),
    onSuccess: (_result, { review }) => {
      // The next album opens, so a queue can be worked through without going back to the list.
      const items = reviews.data?.items.filter(item => item.status === 'open') ?? []
      const index = items.findIndex(item => item.id === review.id)
      go({ review: (items[index + 1] ?? items[index - 1])?.id ?? null })
      return queryClient.invalidateQueries({ queryKey: queryKeys.adminReviews() })
    },
  })
  return (
    <>
      <ReviewAdmin
        status={status}
        onStatusChange={next => go({ status: next })}
        reviews={reviews.data?.items}
        rootNames={Object.fromEntries((roots.data ?? []).map(root => [root.id, root.name]))}
        selectedId={selectedId}
        onSelect={id => go({ review: id })}
        detail={detail.data}
        onResolve={(review, request) => resolve.mutateAsync({ review, request })}
        onSearch={fixMatch.open}
        failures={{ reviews: loadFailure(reviews, 'The reviews did not load'), detail: loadFailure(detail, 'The album did not load') }}
      />
      {fixMatch.dialogs}
    </>
  )
}

const isRunning = (batch: OrganizeBatchSummary) => batch.status === 'applying' || batch.status === 'reverting'

export function AdminOrganizePage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const roots = useRoots()
  const templateInfo = useTemplateInfo()
  const managed = roots.data?.filter(root => root.mode === 'managed')
  const [chosenRoot, setChosenRoot] = useState<string | null>(null)
  const rootId = managed?.find(root => root.id === chosenRoot)?.id ?? managed?.[0]?.id ?? null
  const batches = useQuery({
    queryKey: batchesKey,
    queryFn: () => api.organize.batches({ limit: 50 }),
    refetchInterval: query => query.state.data?.items.some(isRunning) ? RUNNING_REFRESH_MS : false,
  })
  const ofRoot = batches.data?.items.filter(batch => batch.rootId === rootId) ?? []
  const running = ofRoot.find(isRunning) ?? null
  const planned = ofRoot[0]?.status === 'planned' ? ofRoot[0] : null
  const preview = useQuery({ queryKey: batchKey(planned?.id ?? null), queryFn: () => api.organize.batch(planned!.id), enabled: !!planned })
  const fixMatch = useFixMatch()
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.adminOrganize() })

  const plan = useMutation({
    mutationFn: api.organize.preview,
    onSuccess: batch => {
      queryClient.setQueryData(batchKey(batch.id), batch)
      return refresh()
    },
  })
  const apply = useMutation({
    mutationFn: async (albumIds: string[] | null) => {
      const batch = preview.data!
      // Some albums only: plan just those with the same options and apply that batch.
      const target = albumIds ? await api.organize.preview({ rootId: batch.rootId, albumIds, includeUnmatched: batch.includeUnmatched, writeTags: batch.writeTags }) : batch
      return api.organize.apply(target.id)
    },
    // The batch's progress takes the preview's place.
    onSuccess: refresh,
  })
  const revert = useMutation({ mutationFn: (batch: OrganizeBatchSummary) => api.organize.revert(batch.id), onSuccess: refresh })
  return (
    <>
      <OrganizeAdmin
        roots={managed}
        rootId={rootId}
        onRootChange={setChosenRoot}
        preview={planned ? preview.data : undefined}
        defaultTemplate={templateInfo?.defaultTemplate}
        running={running}
        history={batches.data?.items.filter(batch => batch.status !== 'planned')}
        onPreview={(options: OrganizeOptions) => plan.mutateAsync({ rootId: rootId!, ...options })}
        onApply={albumIds => apply.mutateAsync(albumIds)}
        onRevert={batch => revert.mutateAsync(batch)}
        onFixMatch={fixMatch.open}
        failure={loadFailure(roots, 'The folders did not load')}
      />
      {fixMatch.dialogs}
    </>
  )
}

export function AdminSearchIndexPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  // The import row appears once the worker picks the job up: until the newest import changes, the page waits for it.
  const [requestedAfter, setRequestedAfter] = useState<string | null>()
  const newestImport = (data: CatalogIndexStatus | undefined) => (data?.latest ?? data?.active)?.id ?? null
  const waiting = (data: CatalogIndexStatus | undefined) => requestedAfter !== undefined && newestImport(data) === requestedAfter
  const status = useQuery({
    queryKey: catalogIndexKey,
    queryFn: () => api.catalogIndex.status(),
    refetchInterval: query => {
      const state = query.state.data?.latest?.state
      return state === 'running' || state === 'interrupted' || waiting(query.state.data) ? RUNNING_REFRESH_MS : false
    },
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: catalogIndexKey })
  const start = useMutation({
    mutationFn: api.catalogIndex.startImport,
    onSuccess: () => {
      setRequestedAfter(newestImport(status.data))
      return refresh()
    },
  })
  // A cancelled import and a removed index show in the page's state; failures stay in their dialog.
  const cancel = useMutation({ mutationFn: api.catalogIndex.cancelImport, onSuccess: refresh })
  const remove = useMutation({ mutationFn: api.catalogIndex.remove, onSuccess: refresh })
  return (
    <SearchIndexAdmin
      status={status.data}
      starting={waiting(status.data)}
      onStart={request => start.mutateAsync(request)}
      onCancel={() => cancel.mutateAsync()}
      onRemove={() => remove.mutateAsync()}
      failure={loadFailure(status, 'The search index did not load')}
    />
  )
}

export function AdminUsersPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const me = useCurrentUser()
  const users = useQuery({ queryKey: queryKeys.adminUsers(), queryFn: () => api.admin.users() })
  const invites = useQuery({ queryKey: invitesKey, queryFn: () => api.admin.invites() })
  const refresh = (queryKey: readonly unknown[]) => () => queryClient.invalidateQueries({ queryKey })
  const createUser = useMutation({ mutationFn: api.admin.createUser, onSuccess: refresh(queryKeys.adminUsers()) })
  // Failures (the last-admin rule, say) are said where the change was asked for: its dialog, its
  // confirmation or the user's row.
  const updateUser = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserRequest }) => api.admin.updateUser(id, patch),
    onSuccess: (user: User) => {
      if (user.id === me.id) queryClient.setQueryData(queryKeys.me(), user)
      return refresh(queryKeys.adminUsers())()
    },
  })
  const deleteUser = useMutation({ mutationFn: api.admin.deleteUser, onSuccess: refresh(queryKeys.adminUsers()) })
  const createInvite = useMutation({ mutationFn: api.admin.createInvite, onSuccess: refresh(invitesKey) })
  const revokeInvite = useMutation({ mutationFn: api.admin.deleteInvite, onSuccess: refresh(invitesKey) })
  // One user's sign-ins at a time, read while their dialog is open.
  const [securityUserId, setSecurityUserId] = useState<string | null>(null)
  const securityKey = [...queryKeys.adminUsers(), securityUserId, 'security'] as const
  const security = useQuery({ queryKey: securityKey, queryFn: () => api.admin.userSecurity(securityUserId!), enabled: !!securityUserId })
  const refreshSecurity = () => queryClient.invalidateQueries({ queryKey: securityKey })
  return (
    <UsersAdmin
      users={users.data?.items}
      invites={invites.data?.items}
      currentUserId={me.id}
      inviteLink={invite => `${location.origin}/register?invite=${encodeURIComponent(invite.code)}`}
      onCreateUser={request => createUser.mutateAsync(request)}
      onUpdateUser={(id, patch) => updateUser.mutateAsync({ id, patch })}
      onDeleteUser={id => deleteUser.mutateAsync(id)}
      onCreateInvite={request => createInvite.mutateAsync(request)}
      onRevokeInvite={id => revokeInvite.mutateAsync(id)}
      failures={{ users: loadFailure(users, 'The users did not load'), invites: loadFailure(invites, 'The invites did not load') }}
      security={securityUserId ? { userId: securityUserId, data: security.data, failure: loadFailure(security, 'Their sign-ins did not load') } : null}
      onShowSecurity={setSecurityUserId}
      onRevokeUserSession={(id, sessionId) => api.admin.revokeUserSession(id, sessionId).then(refreshSecurity)}
      onRevokeUserSessions={id => api.admin.revokeUserSessions(id).then(refreshSecurity)}
      onResetTwoFactor={id => api.admin.resetTwoFactor(id).then(refreshSecurity)}
    />
  )
}

export function AdminProvidersPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const roots = useRoots()
  const [params, setParams] = useSearchParams()
  const jobStatus = AcquisitionJobStatus.safeParse(params.get('status')).data ?? null
  const providers = useQuery({ queryKey: providersKey, queryFn: () => api.acquisition.providers(), select: page => page.items })
  const policy = useQuery({ queryKey: policyKey, queryFn: () => api.acquisition.policy() })
  const usage = useQuery({ queryKey: usageKey, queryFn: () => api.admin.acquisitionUsage() })
  const jobs = useInfiniteQuery({
    queryKey: [...acquisitionJobsKey, jobStatus],
    queryFn: ({ pageParam }) => api.acquisition.jobs({ status: jobStatus ?? undefined, cursor: pageParam, limit: REQUESTS_PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    select: data => data.pages.flatMap(page => page.items),
    placeholderData: keepPreviousData,
  })
  // A job that ends can change a provider's health too, and a delivery fills the cache.
  useServerEvent('acquisition.updated', () => {
    void queryClient.invalidateQueries({ queryKey: acquisitionJobsKey })
    void queryClient.invalidateQueries({ queryKey: providersKey })
    void queryClient.invalidateQueries({ queryKey: usageKey })
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: providersKey })
  const replace = (provider: AcquisitionProvider) => queryClient.setQueryData<{ items: AcquisitionProvider[] }>(providersKey, page => page && { ...page, items: page.items.map(item => item.id === provider.id ? provider : item) })

  // Each action says how it went where it was asked for: the provider's row, the list or its dialog.
  const create = useMutation({ mutationFn: api.acquisition.createProvider, onSuccess: refresh })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAcquisitionProviderRequest }) => api.acquisition.updateProvider(id, patch),
    onSuccess: (provider: AcquisitionProvider) => {
      replace(provider)
      return refresh()
    },
  })
  const remove = useMutation({ mutationFn: api.acquisition.deleteProvider, onSuccess: refresh })
  const test = useMutation({ mutationFn: api.acquisition.testProvider, onSuccess: replace })
  const clearMisses = useMutation({ mutationFn: api.acquisition.clearProviderMisses, onSuccess: ({ provider }) => replace(provider) })
  const savePolicy = useMutation({
    mutationFn: (patch: UpdateAcquisitionPolicy) => api.acquisition.updatePolicy(patch),
    onSuccess: (updated: AcquisitionPolicy) => {
      queryClient.setQueryData(policyKey, updated)
      // The usage carries the limit.
      return queryClient.invalidateQueries({ queryKey: usageKey })
    },
  })

  return (
    <ProvidersAdmin
      providers={providers.data}
      policy={policy.data}
      usage={usage.data}
      managedRoots={managedOnly(roots.data)}
      jobs={jobs.data}
      moreJobs={jobs.hasNextPage && !jobs.isPlaceholderData ? { loading: jobs.isFetchingNextPage, failed: jobs.isFetchNextPageError, load: () => void jobs.fetchNextPage() } : undefined}
      jobStatus={jobStatus}
      onJobStatusChange={status => setParams(status ? { status } : {}, { replace: true })}
      onCreate={request => create.mutateAsync(request)}
      onUpdate={(id, patch) => update.mutateAsync({ id, patch })}
      onDelete={id => remove.mutateAsync(id)}
      onTest={id => test.mutateAsync(id)}
      onClearMisses={id => clearMisses.mutateAsync(id)}
      onSavePolicy={patch => savePolicy.mutateAsync(patch)}
      failures={{
        providers: loadFailure(providers, 'The providers did not load'),
        policy: loadFailure(policy, 'The policy did not load'),
        usage: loadFailure(usage, 'The cache’s size did not load'),
        jobs: loadFailure(jobs, 'The requests did not load'),
      }}
    />
  )
}

export function AdminSettingsPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => api.admin.settings() })
  const roots = useRoots()
  // Every control says what the server refused under itself (an inbox that does not exist, say).
  const save = useMutation({
    mutationFn: (patch: UpdateServerSettings) => api.admin.updateSettings(patch),
    onSuccess: (updated: ServerSettings) => {
      queryClient.setQueryData(settingsKey, updated)
      // The server name and the registration rule show on the sign-in screens; the import folder and limits on Add music.
      return Promise.all([setupStatusKey, importsKey].map(queryKey => queryClient.invalidateQueries({ queryKey })))
    },
  })
  return (
    <ServerSettingsAdmin
      settings={settings.data}
      failure={loadFailure(settings, 'The server settings did not load')}
      managedRoots={managedOnly(roots.data)}
      onSave={patch => save.mutateAsync(patch)}
      status={save.isPending ? 'saving' : save.isSuccess ? 'saved' : 'idle'}
    />
  )
}

export function AdminJobsPage() {
  const api = useApi()
  const jobs = useQuery({ queryKey: queryKeys.adminJobs(), queryFn: () => api.admin.jobs(), refetchInterval: JOBS_REFRESH_MS })
  return <JobsAdmin jobs={jobs.data} updatedAt={jobs.dataUpdatedAt} onRefresh={() => void jobs.refetch()} failure={loadFailure(jobs, 'The queues did not load')} />
}
