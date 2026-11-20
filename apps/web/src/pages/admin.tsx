import { queryKeys, type UpdateUserRequest } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '@/api/services'
import { setupStatusKey, useCurrentUser } from '@/auth/session'
import { JobsAdmin, LibraryAdmin } from '@/components/admin/LibraryAdmin'
import { ProvidersAdmin } from '@/components/admin/ProvidersAdmin'
import { OrganizeAdmin, ReviewAdmin } from '@/components/admin/ReviewAdmin'
import { ServerSettingsAdmin } from '@/components/admin/ServerSettingsAdmin'
import { UsersAdmin } from '@/components/admin/UsersAdmin'
import { libraryRoots, libraryStats, organizeMoves, providers as initialProviders, reviews as initialReviews, scanProgress } from '@/fixtures/server'
import { toast } from '@/lib/toast'

const invitesKey = [...queryKeys.admin(), 'invites'] as const
const settingsKey = [...queryKeys.admin(), 'settings'] as const
const JOBS_REFRESH_MS = 3000

export { AdminLayout } from '@/components/admin/AdminLayout'

const needsServer = (title: string) => () => toast({ title, description: 'This needs the server.' })

export function AdminLibraryPage() {
  return (
    <LibraryAdmin
      roots={libraryRoots}
      stats={libraryStats}
      progress={[scanProgress]}
      onScan={needsServer('Scan requested')}
      onRootAction={needsServer('Folder updated')}
      onAddRoot={root => toast({ title: 'Folder added', description: root.path })}
    />
  )
}

export function AdminReviewsPage() {
  const [reviews, setReviews] = useState(initialReviews)
  const resolve = (id: string) => setReviews(current => current.filter(review => review.id !== id))
  return <ReviewAdmin reviews={reviews} onAccept={resolve} onSkip={resolve} />
}

export function AdminOrganizePage() {
  return <OrganizeAdmin template="{albumartist}/{album} ({year})/{disc}{track:02} {title}" moves={organizeMoves} onApply={needsServer('Applying moves')} onUndo={needsServer('Undoing the last batch')} />
}

export function AdminUsersPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const me = useCurrentUser()
  const users = useQuery({ queryKey: queryKeys.adminUsers(), queryFn: () => api.admin.users() })
  const invites = useQuery({ queryKey: invitesKey, queryFn: () => api.admin.invites() })
  const refresh = (queryKey: readonly unknown[]) => () => queryClient.invalidateQueries({ queryKey })
  const createUser = useMutation({ mutationFn: api.admin.createUser, onSuccess: refresh(queryKeys.adminUsers()), meta: { inline: true } })
  const updateUser = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserRequest }) => api.admin.updateUser(id, patch),
    onSuccess: (user, { patch }) => {
      if (patch.password) toast({ title: `Password changed for @${user.username}` })
      if (patch.disabled !== undefined) toast({ title: `${patch.disabled ? 'Disabled' : 'Enabled'} @${user.username}` })
      if (user.id === me.id) queryClient.setQueryData(queryKeys.me(), user)
      return refresh(queryKeys.adminUsers())()
    },
  })
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
      onUpdateUser={(id, patch) => updateUser.mutateAsync({ id, patch })}
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
