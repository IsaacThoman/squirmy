import type { Invite, ServerSettings } from '@squirmy/contracts'
import { useState } from 'react'
import { OrganizeAdmin, ReviewAdmin } from '@/components/admin/ReviewAdmin'
import { JobsAdmin, LibraryAdmin } from '@/components/admin/LibraryAdmin'
import { ProvidersAdmin, ServerSettingsAdmin, UsersAdmin } from '@/components/admin/AccountsAdmin'
import {
  currentUser, invites, jobs, libraryRoots, libraryStats, organizeMoves, providers as initialProviders, reviews as initialReviews,
  scanProgress, serverSettings, users,
} from '@/fixtures/server'
import { toast } from '@/lib/toast'

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
  return (
    <UsersAdmin
      users={users}
      invites={invites}
      currentUserId={currentUser.id}
      onUserAction={needsServer('User updated')}
      onCreateInvite={needsServer('Invite created')}
      onRevokeInvite={needsServer('Invite revoked')}
      onCopyInvite={(invite: Invite) => {
        void navigator.clipboard?.writeText(`${location.origin}/register?invite=${invite.code}`)
        toast({ title: 'Invite link copied' })
      }}
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
  const [settings, setSettings] = useState<ServerSettings>(serverSettings)
  return <ServerSettingsAdmin settings={settings} onChange={patch => setSettings(current => ({ ...current, ...patch }))} onSetSecret={needsServer('Saving a key')} />
}

export function AdminJobsPage() {
  return <JobsAdmin jobs={jobs} onRefresh={needsServer('Refreshed')} />
}
