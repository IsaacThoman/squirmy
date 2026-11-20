import { MatchReviewStatus, queryKeys, type AlbumSummary, type CatalogIndexStatus, type LibraryRoot, type MatchReview, type OrganizeBatchSummary, type ResolveReviewRequest, type UpdateLibraryRootRequest, type User, type UpdateUserRequest } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useFolderListing } from '@/api/folders'
import { useApi } from '@/api/services'
import { setupStatusKey, useCurrentUser } from '@/auth/session'
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
import { providers as initialProviders } from '@/fixtures/server'
import { plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useServerEvent } from '@/realtime/realtime-context'

const needsServer = (title: string) => () => toast({ title, description: 'This needs the server.' })
const invitesKey = [...queryKeys.admin(), 'invites'] as const
const settingsKey = [...queryKeys.admin(), 'settings'] as const
// Under `library` so ingest and matching, which invalidate it, refresh the numbers too.
const statsKey = [...queryKeys.library(), 'stats'] as const
const reviewsKey = (status: MatchReviewStatus) => [...queryKeys.adminReviews(), 'list', status] as const
const reviewKey = (id: string | null) => [...queryKeys.adminReviews(), 'detail', id] as const
const batchesKey = [...queryKeys.adminOrganize(), 'batches'] as const
const batchKey = (id: string | null) => [...queryKeys.adminOrganize(), 'batch', id] as const
const catalogIndexKey = [...queryKeys.admin(), 'catalog-index'] as const
const JOBS_REFRESH_MS = 3000
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

export function AdminLayout() {
  return <AdminFrame counts={{ '/admin/reviews': useOpenReviewCount() }} />
}

/** "Fix match" from anywhere in admin: the album search, then the dialog for the album picked. */
const MAX_FIND_ALBUMS = 5000
const searchKey = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function useFixMatch() {
  const api = useApi()
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [albumId, setAlbumId] = useState<string | null>(null)
  // The library search route is not on the server yet, so this filters the album list, which
  // is plenty for an admin's occasional fix.
  const albums = useQuery({
    queryKey: [...queryKeys.libraryAlbums(), 'by-title'],
    queryFn: async () => {
      const items: AlbumSummary[] = []
      let cursor: string | undefined
      do {
        const page = await api.catalog.albums({ sort: 'title', limit: 200, cursor })
        items.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor && items.length < MAX_FIND_ALBUMS)
      return items
    },
    enabled: finding,
  })
  const words = searchKey(query).split(' ').filter(Boolean)
  const found = words.length ? albums.data?.filter(album => words.every(word => searchKey(`${album.title} ${album.artistCredit}`).includes(word))).slice(0, 12) : undefined
  const dialogs = (
    <>
      <FindAlbumDialog
        open={finding}
        onOpenChange={setFinding}
        query={query}
        onQueryChange={setQuery}
        albums={found}
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
  const stats = useQuery({ queryKey: statsKey, queryFn: () => api.library.stats() })
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

  const scan = useMutation({
    mutationFn: api.library.scanRoot,
    onSuccess: ({ queued }) => {
      if (!queued) toast({ title: 'Already scanning', description: 'The folder is scanned once the current scan finishes.' })
      return refresh()
    },
  })
  const add = useMutation({
    mutationFn: api.library.createRoot,
    onSuccess: root => {
      toast({ title: `Scanning ${root.name}`, description: 'Music shows up as its tags are read.' })
      return refresh()
    },
    meta: { inline: true },
  })
  const rootUpdate = {
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLibraryRootRequest }) => api.library.updateRoot(id, patch),
    onSuccess: (root: LibraryRoot) => {
      queryClient.setQueryData(queryKeys.adminRoots(), (page: { items: LibraryRoot[] } | undefined) => page && { ...page, items: page.items.map(item => item.id === root.id ? root : item) })
      return refresh()
    },
  }
  // The edit dialog shows its failures next to its fields; enabling from the menu has only a toast.
  const edit = useMutation({ ...rootUpdate, meta: { inline: true } })
  const toggle = useMutation(rootUpdate)
  const remove = useMutation({
    mutationFn: api.library.deleteRoot,
    onSuccess: () => {
      toast({ title: 'Folder removed', description: 'Nothing on disk was touched.' })
      return refresh()
    },
  })
  return (
    <>
      <LibraryAdmin
        roots={roots.data}
        stats={stats.data}
        openReviews={openReviews}
        progress={progress}
        folders={{ path: listing.data?.path ?? browsePath, listing: listing.data, error: listing.isError ? errorMessage(listing.error) : undefined, onBrowse: setBrowsePath }}
        onScan={id => scan.mutateAsync(id)}
        onAdd={request => add.mutateAsync(request)}
        onUpdate={(id, patch) => (Object.keys(patch).length === 1 && patch.enabled !== undefined ? toggle : edit).mutateAsync({ id, patch })}
        onRemove={id => remove.mutateAsync(id)}
        onFixMatch={fixMatch.find}
      />
      {fixMatch.dialogs}
    </>
  )
}

const resolvedTitle = (request: ResolveReviewRequest) => 'releaseMbid' in request ? 'Release applied' : request.action === 'keep_local' ? 'Kept as tagged' : 'Review dismissed'

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
    onSuccess: (_result, { review, request }) => {
      toast({ title: resolvedTitle(request), description: review.summary.album ?? undefined })
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
    onSuccess: batch => {
      toast({ title: `Applying ${plural(batch.counts.planned, 'move')}`, description: 'Progress shows here; you can leave the page.' })
      return refresh()
    },
  })
  const revert = useMutation({
    mutationFn: (batch: OrganizeBatchSummary) => api.organize.revert(batch.id),
    onSuccess: () => {
      toast({ title: 'Undoing the batch', description: 'Files move back to where they were.' })
      return refresh()
    },
  })
  return (
    <>
      <OrganizeAdmin
        roots={managed}
        rootId={rootId}
        onRootChange={setChosenRoot}
        preview={planned ? preview.data : undefined}
        running={running}
        history={batches.data?.items.filter(batch => batch.status !== 'planned')}
        onPreview={(options: OrganizeOptions) => plan.mutateAsync({ rootId: rootId!, ...options })}
        onApply={albumIds => apply.mutateAsync(albumIds)}
        onRevert={batch => revert.mutateAsync(batch)}
        onFixMatch={fixMatch.open}
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
    refetchInterval: query => query.state.data?.latest?.state === 'running' || waiting(query.state.data) ? RUNNING_REFRESH_MS : false,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: catalogIndexKey })
  const start = useMutation({
    mutationFn: api.catalogIndex.startImport,
    onSuccess: () => {
      setRequestedAfter(newestImport(status.data))
      return refresh()
    },
    meta: { inline: true },
  })
  const cancel = useMutation({
    mutationFn: api.catalogIndex.cancelImport,
    onSuccess: () => {
      toast({ title: 'Import cancelled' })
      return refresh()
    },
  })
  const remove = useMutation({
    mutationFn: api.catalogIndex.remove,
    onSuccess: () => {
      toast({ title: 'Search index removed' })
      return refresh()
    },
  })
  return (
    <SearchIndexAdmin
      status={status.data}
      starting={waiting(status.data)}
      onStart={request => start.mutateAsync(request)}
      onCancel={() => cancel.mutateAsync()}
      onRemove={() => remove.mutateAsync()}
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
  const createUser = useMutation({ mutationFn: api.admin.createUser, onSuccess: refresh(queryKeys.adminUsers()), meta: { inline: true } })
  const userUpdate = {
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserRequest }) => api.admin.updateUser(id, patch),
    onSuccess: (user: User, { patch }: { patch: UpdateUserRequest }) => {
      if (patch.password) toast({ title: `Password changed for @${user.username}` })
      if (patch.disabled !== undefined) toast({ title: `${patch.disabled ? 'Disabled' : 'Enabled'} @${user.username}` })
      if (user.id === me.id) queryClient.setQueryData(queryKeys.me(), user)
      return refresh(queryKeys.adminUsers())()
    },
  }
  // The edit and password dialogs show failures (the last-admin rule, say) next to their fields;
  // enabling and disabling come from the menu and a confirmation, so theirs become a toast.
  const editUser = useMutation({ ...userUpdate, meta: { inline: true } })
  const toggleUser = useMutation(userUpdate)
  const deleteUser = useMutation({ mutationFn: api.admin.deleteUser, onSuccess: refresh(queryKeys.adminUsers()) })
  const createInvite = useMutation({ mutationFn: api.admin.createInvite, onSuccess: refresh(invitesKey), meta: { inline: true } })
  const revokeInvite = useMutation({ mutationFn: api.admin.deleteInvite, onSuccess: refresh(invitesKey) })
  return (
    <UsersAdmin
      users={users.data?.items}
      invites={invites.data?.items}
      currentUserId={me.id}
      inviteLink={invite => `${location.origin}/register?invite=${encodeURIComponent(invite.code)}`}
      onCreateUser={request => createUser.mutateAsync(request)}
      onUpdateUser={(id, patch) => (patch.disabled === undefined ? editUser : toggleUser).mutateAsync({ id, patch })}
      onDeleteUser={id => deleteUser.mutateAsync(id)}
      onCreateInvite={request => createInvite.mutateAsync(request)}
      onRevokeInvite={id => revokeInvite.mutateAsync(id)}
    />
  )
}

export function AdminProvidersPage() {
  const [providers, setProviders] = useState(initialProviders)
  return (
    <ProvidersAdmin
      providers={providers}
      onToggle={(id, enabled) => setProviders(current => current.map(provider => provider.id === id ? { ...provider, enabled, status: enabled ? 'healthy' : 'disabled' } : provider))}
      onRegister={needsServer('Registering a provider')}
    />
  )
}

export function AdminSettingsPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => api.admin.settings() })
  const save = useMutation({
    mutationFn: api.admin.updateSettings,
    onSuccess: updated => {
      queryClient.setQueryData(settingsKey, updated)
      // The server name and the registration rule show on the sign-in screens.
      return queryClient.invalidateQueries({ queryKey: setupStatusKey })
    },
  })
  return (
    <ServerSettingsAdmin
      settings={settings.data}
      onSave={patch => save.mutateAsync(patch)}
      status={save.isPending ? 'saving' : save.isSuccess ? 'saved' : 'idle'}
    />
  )
}

export function AdminJobsPage() {
  const api = useApi()
  const jobs = useQuery({ queryKey: queryKeys.adminJobs(), queryFn: () => api.admin.jobs(), refetchInterval: JOBS_REFRESH_MS })
  return <JobsAdmin jobs={jobs.data} updatedAt={jobs.dataUpdatedAt} onRefresh={() => void jobs.refetch()} />
}
