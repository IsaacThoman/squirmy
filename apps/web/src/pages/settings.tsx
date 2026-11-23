import { queryKeys, type ScrobblingStatus, type ScrobbleTarget, type UpdateUserSettings, type UserSettings } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useScrobbling, useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { useCurrentUser, useSetupStatus } from '@/auth/session'
import type { SettingsDialogState } from '@/components/layout/AppShell'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { loadFailure } from '@/components/ui/load-failure'
import { browserName, deviceName } from '@/lib/device'
import { usePlayerControls } from '@/player/player-context'

const appPasswordsKey = ['app-passwords'] as const

/** What Last.fm's return to `/settings?lastfm=` says, in the Scrobbling section it opens. */
const lastFmReturns: Record<string, { message: string; ok: boolean }> = {
  connected: { message: 'Connected to Last.fm.', ok: true },
  denied: { message: 'Last.fm was not connected. The connection was not approved.', ok: false },
  invalid_state: { message: 'That Last.fm link expired. Start connecting again.', ok: false },
  error: { message: 'Last.fm did not answer. Try again in a moment.', ok: false },
}

const scrobbleSettings: (keyof UpdateUserSettings)[] = ['scrobbleListenBrainz', 'scrobbleLastFm']

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
  const listenBrainz = useMutation({ mutationFn: (token: string) => api.scrobble.connectListenBrainz({ token }), onSuccess: save })
  const lastFm = useMutation({ mutationFn: () => api.scrobble.startLastFm(), onSuccess: ({ url }) => window.location.assign(url) })
  const disconnect = useMutation({
    mutationFn: (target: ScrobbleTarget) => (target === 'listenbrainz' ? api.scrobble.disconnectListenBrainz() : api.scrobble.disconnectLastFm()),
    onSuccess: save,
  })
  return { listenBrainz, lastFm, disconnect }
}

/** The settings dialog with the signed-in user's settings, connections and app passwords. */
export function SettingsDialogHost({ open, section, lastFm, onOpenChange, onSectionChange }: SettingsDialogState) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const logout = useLogout()
  const controls = usePlayerControls()
  const status = useSetupStatus().data
  const settings = useUserSettings()
  const scrobbling = useScrobbling()
  const update = useSettingsUpdate()
  const connections = useScrobbleConnections()
  const [name, setName] = useState(browserName)
  const passwords = useQuery({ queryKey: appPasswordsKey, queryFn: () => api.auth.appPasswords(), enabled: open })
  const refreshPasswords = () => queryClient.invalidateQueries({ queryKey: appPasswordsKey })
  const createPassword = useMutation({ mutationFn: api.auth.createAppPassword, onSuccess: refreshPasswords })
  // The revoked password leaves the list; the confirmation says a failure.
  const revokePassword = useMutation({ mutationFn: api.auth.deleteAppPassword, onSuccess: refreshPasswords })
  // Said in the Account section once the dialog that changed it closes.
  const changePassword = useMutation({ mutationFn: api.auth.changePassword })
  // Only the admin route can rename a user, so only admins can rename themselves.
  const rename = useMutation({
    mutationFn: (displayName: string | null) => api.admin.updateUser(user.id, { displayName }),
    onSuccess: updated => queryClient.setQueryData(queryKeys.me(), updated),
  })
  // A refused change is said under the controls that made it: a scrobbling switch in Scrobbling, the rest in Playback.
  const refused = update.isError && update.variables
    ? { [Object.keys(update.variables).some(key => scrobbleSettings.includes(key as keyof UpdateUserSettings)) ? 'scrobbling' : 'playback']: `Couldn’t save that change. ${errorMessage(update.error)}` }
    : {}
  const lastFmStart = connections.lastFm.isError ? `Couldn’t start connecting to Last.fm. ${errorMessage(connections.lastFm.error)}` : undefined
  // What the dialog said goes with it: opened again, it starts afresh.
  const change = (next: boolean) => {
    if (!next) {
      update.reset()
      changePassword.reset()
      connections.lastFm.reset()
    }
    onOpenChange(next)
  }
  return (
    <SettingsDialog
      open={open}
      onOpenChange={change}
      section={section}
      onSectionChange={onSectionChange}
      user={user}
      serverName={status?.serverName ?? 'Squirmy'}
      version={status?.version ?? ''}
      settings={settings.data}
      onSettingsChange={patch => update.mutate(patch)}
      deviceName={name}
      defaultDeviceName={deviceName(navigator.userAgent)}
      onDeviceNameChange={next => {
        controls.renameDevice(next)
        setName(browserName())
      }}
      scrobbling={scrobbling.data}
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
      failures={{
        settings: loadFailure(settings, 'Your playback settings did not load'),
        scrobbling: loadFailure(scrobbling, 'Your scrobbling connections did not load'),
        appPasswords: loadFailure(passwords, 'Your app passwords did not load'),
      }}
      errors={{ ...refused, scrobbling: refused.scrobbling ?? lastFmStart }}
      lastFm={lastFm === undefined ? undefined : lastFmReturns[lastFm] ?? lastFmReturns.error}
      passwordChanged={changePassword.isSuccess}
    />
  )
}
