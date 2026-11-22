import { queryKeys, type ScrobblingStatus, type ScrobbleTarget, type UpdateUserSettings, type UserSettings } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useScrobbling, useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { useCurrentUser, useSetupStatus } from '@/auth/session'
import type { SettingsDialogState } from '@/components/layout/AppShell'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { browserName, deviceName } from '@/lib/device'
import { toast } from '@/lib/toast'
import { usePlayerControls } from '@/player/player-context'

const appPasswordsKey = ['app-passwords'] as const

/** The user's playback settings, saved as they change. */
function useSettingsUpdate() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateUserSettings) => api.userdata.updateSettings(patch),
    onMutate: patch => queryClient.setQueryData<UserSettings>(queryKeys.settings(), settings => settings && { ...settings, ...patch }),
    onSuccess: settings => {
      queryClient.setQueryData(queryKeys.settings(), settings)
      // A service's switch is a setting, and the scrobbling status reports it.
      return queryClient.invalidateQueries({ queryKey: queryKeys.scrobbling() })
    },
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
  })
}

function useScrobbleConnections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const save = (status: ScrobblingStatus) => queryClient.setQueryData(queryKeys.scrobbling(), status)
  const listenBrainz = useMutation({ mutationFn: (token: string) => api.scrobble.connectListenBrainz({ token }), onSuccess: save, meta: { inline: true } })
  const lastFm = useMutation({ mutationFn: () => api.scrobble.startLastFm(), onSuccess: ({ url }) => window.location.assign(url) })
  const disconnect = useMutation({
    mutationFn: (target: ScrobbleTarget) => (target === 'listenbrainz' ? api.scrobble.disconnectListenBrainz() : api.scrobble.disconnectLastFm()),
    onSuccess: save,
  })
  return { listenBrainz, lastFm, disconnect }
}

/** The settings dialog with the signed-in user's settings, connections and app passwords. */
export function SettingsDialogHost({ open, section, onOpenChange, onSectionChange }: SettingsDialogState) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const logout = useLogout()
  const controls = usePlayerControls()
  const status = useSetupStatus().data
  const settings = useUserSettings().data
  const scrobbling = useScrobbling().data
  const update = useSettingsUpdate()
  const connections = useScrobbleConnections()
  const [name, setName] = useState(browserName)
  const passwords = useQuery({ queryKey: appPasswordsKey, queryFn: () => api.auth.appPasswords(), enabled: open })
  const refreshPasswords = () => queryClient.invalidateQueries({ queryKey: appPasswordsKey })
  const createPassword = useMutation({ mutationFn: api.auth.createAppPassword, onSuccess: refreshPasswords, meta: { inline: true } })
  const revokePassword = useMutation({
    mutationFn: api.auth.deleteAppPassword,
    onSuccess: () => {
      toast({ title: 'App password revoked' })
      return refreshPasswords()
    },
  })
  const changePassword = useMutation({
    mutationFn: api.auth.changePassword,
    onSuccess: () => toast({ title: 'Password changed', description: 'Your other sessions were signed out.' }),
    meta: { inline: true },
  })
  // Only the admin route can rename a user, so only admins can rename themselves.
  const rename = useMutation({
    mutationFn: (displayName: string | null) => api.admin.updateUser(user.id, { displayName }),
    onSuccess: updated => queryClient.setQueryData(queryKeys.me(), updated),
    meta: { inline: true },
  })
  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      section={section}
      onSectionChange={onSectionChange}
      user={user}
      serverName={status?.serverName ?? 'Squirmy'}
      version={status?.version ?? ''}
      settings={settings}
      onSettingsChange={patch => update.mutate(patch)}
      deviceName={name}
      defaultDeviceName={deviceName(navigator.userAgent)}
      onDeviceNameChange={next => {
        controls.renameDevice(next)
        setName(browserName())
        toast({ title: 'Browser renamed', description: browserName() })
      }}
      scrobbling={scrobbling}
      onConnectListenBrainz={token => connections.listenBrainz.mutateAsync(token)}
      onConnectLastFm={() => connections.lastFm.mutate()}
      onDisconnect={target => connections.disconnect.mutateAsync(target)}
      appPasswords={passwords.data?.items}
      onCreateAppPassword={request => createPassword.mutateAsync(request)}
      onRevokeAppPassword={id => revokePassword.mutateAsync(id)}
      onChangePassword={request => changePassword.mutateAsync(request)}
      onRename={user.role === 'admin' ? displayName => rename.mutateAsync(displayName) : undefined}
      onLogout={logout}
      onOpenAdmin={user.role === 'admin' ? () => { onOpenChange(false); void navigate('/admin') } : undefined}
    />
  )
}
