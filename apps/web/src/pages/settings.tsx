import { queryKeys, type ScrobblingStatus, type ScrobbleTarget, type UpdateUserSettings, type UserSettings } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useScrobbling, useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { useCurrentUser, useSetupStatus, useSharingEnabled } from '@/auth/session'
import type { SettingsDialogState } from '@/components/layout/AppShell'
import type { SecuritySettingsProps } from '@/components/settings/SecuritySettings'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { loadFailure } from '@/components/ui/load-failure'
import { canUploadMusic } from '@/lib/catalog'
import { browserName, deviceName } from '@/lib/device'
import { browserSupportsPasskeys, createPasskey, passkeyCancelled } from '@/lib/passkeys'
import { useEngine } from '@/player/engine/engine-context'
import { supportsOutputDevice } from '@/player/engine/output'
import { usePlayerControls } from '@/player/player-context'

const appPasswordsKey = ['app-passwords'] as const
const securityKey = ['account-security'] as const
const sessionsKey = ['auth-sessions'] as const

/** Settings → Security: the second factor and the signed-in devices, read while the dialog is open. */
function useSecuritySettings(open: boolean, ssoNotice: string | undefined): SecuritySettingsProps {
  const api = useApi()
  const queryClient = useQueryClient()
  const status = useSetupStatus().data
  const serverPasskeys = status?.passkeysAvailable ?? false
  const security = useQuery({ queryKey: securityKey, queryFn: () => api.auth.security(), enabled: open })
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: () => api.auth.sessions(), enabled: open })
  const refreshSecurity = () => queryClient.invalidateQueries({ queryKey: securityKey })
  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: sessionsKey })
  return {
    security: security.data,
    sessions: sessions.data?.items,
    failures: {
      security: loadFailure(security, 'Your sign-in settings did not load'),
      sessions: loadFailure(sessions, 'Your signed-in devices did not load'),
    },
    onStartTwoFactor: request => api.auth.startTwoFactor(request),
    onEnableTwoFactor: async request => {
      const codes = await api.auth.enableTwoFactor(request)
      await refreshSecurity()
      return codes
    },
    onDisableTwoFactor: request => api.auth.disableTwoFactor(request).then(refreshSecurity),
    onRegenerateRecoveryCodes: async request => {
      const codes = await api.auth.regenerateRecoveryCodes(request)
      await refreshSecurity()
      return codes
    },
    onRevokeSession: id => api.auth.revokeSession(id).then(refreshSessions),
    onRevokeOtherSessions: () => api.auth.revokeOtherSessions().then(refreshSessions),
    passkeys: { server: serverPasskeys, browser: browserSupportsPasskeys() },
    defaultPasskeyName: browserName(),
    onAddPasskey: async ({ currentPassword, name }) => {
      const { challenge, options } = await api.auth.startPasskey({ currentPassword })
      let response
      try {
        response = await createPasskey(options)
      } catch (error) {
        if (passkeyCancelled(error)) return
        throw error
      }
      await api.auth.addPasskey({ challenge, name, response })
      await refreshSecurity()
    },
    onRenamePasskey: (id, name) => api.auth.renamePasskey(id, { name }).then(refreshSecurity),
    onDeletePasskey: id => api.auth.deletePasskey(id).then(refreshSecurity),
    sso: status?.ssoName ? { name: status.ssoName } : null,
    onLinkSso: async request => window.location.assign((await api.auth.linkSso(request)).url),
    onUnlinkSso: id => api.auth.unlinkSso(id).then(refreshSecurity),
    ssoNotice,
  }
}

/** What Last.fm's return to `/settings?lastfm=` says, in the Scrobbling section it opens. */
const lastFmReturns: Record<string, { message: string; ok: boolean }> = {
  connected: { message: 'Connected to Last.fm.', ok: true },
  denied: { message: 'Last.fm was not connected. The connection was not approved.', ok: false },
  invalid_state: { message: 'That Last.fm link expired. Start connecting again.', ok: false },
  error: { message: 'Last.fm did not answer. Try again in a moment.', ok: false },
}

const scrobbleSettings: (keyof UpdateUserSettings)[] = ['scrobbleListenBrainz', 'scrobbleLastFm', 'syncListenBrainzHearts', 'syncLastFmHearts', 'shareNowPlaying']

/** The section whose controls made a change: a scrobbling switch is in Scrobbling, the library's and explicit content's in Library, the rest in Playback. */
function refusedIn(patch: UpdateUserSettings): 'scrobbling' | 'library' | 'playback' {
  const keys = Object.keys(patch) as (keyof UpdateUserSettings)[]
  if (keys.some(key => scrobbleSettings.includes(key))) return 'scrobbling'
  return keys.includes('libraryIncludesServerMusic') || keys.includes('allowExplicit') ? 'library' : 'playback'
}

/** The user's playback settings, saved as they change. */
function useSettingsUpdate() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateUserSettings) => api.userdata.updateSettings(patch),
    onMutate: patch => queryClient.setQueryData<UserSettings>(queryKeys.settings(), settings => settings && { ...settings, ...patch }),
    onSuccess: (settings, patch) => {
      queryClient.setQueryData(queryKeys.settings(), settings)
      // A service's switch is a setting, and the scrobbling status reports it. The library's
      // switch changes what is in the library everywhere; the server says so too, and this
      // browser does not wait for it.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.scrobbling() }),
        ...patch.libraryIncludesServerMusic !== undefined ? [queryClient.invalidateQueries({ queryKey: queryKeys.library() })] : [],
        // The user says whether explicit songs play (`allowsExplicit`), which grays them everywhere.
        ...patch.allowExplicit !== undefined ? [queryClient.invalidateQueries({ queryKey: queryKeys.me(), exact: true })] : [],
      ])
    },
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings() }),
  })
}

function useScrobbleConnections() {
  const api = useApi()
  const queryClient = useQueryClient()
  const save = (status: ScrobblingStatus) => queryClient.setQueryData(queryKeys.scrobbling(), status)
  const listenBrainz = useMutation({ mutationFn: (body: { token: string; apiUrl?: string }) => api.scrobble.connectListenBrainz(body), onSuccess: save })
  const lastFm = useMutation({ mutationFn: () => api.scrobble.startLastFm(), onSuccess: ({ url }) => window.location.assign(url) })
  const disconnect = useMutation({
    mutationFn: (target: ScrobbleTarget) => (target === 'listenbrainz' ? api.scrobble.disconnectListenBrainz() : api.scrobble.disconnectLastFm()),
    onSuccess: save,
  })
  return { listenBrainz, lastFm, disconnect }
}

/** The settings dialog with the signed-in user's settings, connections and app passwords. */
export function SettingsDialogHost({ open, section, lastFm, sso, onOpenChange, onSectionChange }: SettingsDialogState) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const logout = useLogout()
  const controls = usePlayerControls()
  const engine = useEngine()
  const status = useSetupStatus().data
  const settings = useUserSettings()
  const scrobbling = useScrobbling()
  const update = useSettingsUpdate()
  const connections = useScrobbleConnections()
  const [name, setName] = useState(browserName)
  const passwords = useQuery({ queryKey: appPasswordsKey, queryFn: () => api.auth.appPasswords(), enabled: open })
  const security = useSecuritySettings(open, sso)
  const refreshPasswords = () => queryClient.invalidateQueries({ queryKey: appPasswordsKey })
  const createPassword = useMutation({ mutationFn: api.auth.createAppPassword, onSuccess: refreshPasswords })
  // The revoked password leaves the list; the confirmation says a failure.
  const revokePassword = useMutation({ mutationFn: api.auth.deleteAppPassword, onSuccess: refreshPasswords })
  const sharingEnabled = useSharingEnabled()
  const shares = useQuery({ queryKey: queryKeys.shares(), queryFn: () => api.share.list({ limit: 200 }), enabled: open })
  // The server tells the user's other screens; this one refreshes now.
  const revokeShare = useMutation({ mutationFn: (id: string) => api.share.revoke(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.shares() }) })
  // Said in the Account section once the dialog that changed it closes.
  const changePassword = useMutation({ mutationFn: api.auth.changePassword, onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey }) })
  // Only the admin route can rename a user, so only admins can rename themselves.
  const rename = useMutation({
    mutationFn: (displayName: string | null) => api.admin.updateUser(user.id, { displayName }),
    onSuccess: updated => queryClient.setQueryData(queryKeys.me(), updated),
  })
  // A refused change is said under the controls that made it: a scrobbling switch in Scrobbling, the rest in Playback.
  const refused = update.isError && update.variables
    ? { [refusedIn(update.variables)]: `Couldn’t save that change. ${errorMessage(update.error)}` }
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
      boosts={engine?.canBoost ?? false}
      choosesOutput={supportsOutputDevice()}
      deviceName={name}
      defaultDeviceName={deviceName(navigator.userAgent)}
      onDeviceNameChange={next => {
        controls.renameDevice(next)
        setName(browserName())
      }}
      scrobbling={scrobbling.data}
      onConnectListenBrainz={(token, apiUrl) => connections.listenBrainz.mutateAsync({ token, apiUrl })}
      onConnectLastFm={() => connections.lastFm.mutate()}
      onDisconnect={target => connections.disconnect.mutateAsync(target)}
      appPasswords={passwords.data?.items}
      onCreateAppPassword={request => createPassword.mutateAsync(request)}
      onRevokeAppPassword={id => revokePassword.mutateAsync(id)}
      shareLinks={shares.data?.items}
      sharingEnabled={sharingEnabled}
      onRevokeShareLink={id => revokeShare.mutateAsync(id)}
      onChangePassword={request => changePassword.mutateAsync(request)}
      security={security}
      onRename={user.role === 'admin' ? displayName => rename.mutateAsync(displayName) : undefined}
      onLogout={logout}
      onOpenAdmin={user.role === 'admin' ? () => { onOpenChange(false); void navigate('/admin') } : undefined}
      onOpenUploads={canUploadMusic(user) ? () => { onOpenChange(false); void navigate('/uploads') } : undefined}
      failures={{
        settings: loadFailure(settings, 'Your playback settings did not load'),
        sharing: loadFailure(settings, 'Your now-playing sharing setting did not load'),
        scrobbling: loadFailure(scrobbling, 'Your scrobbling connections did not load'),
        appPasswords: loadFailure(passwords, 'Your app passwords did not load'),
        shareLinks: loadFailure(shares, 'Your share links did not load'),
      }}
      errors={{ ...refused, scrobbling: refused.scrobbling ?? lastFmStart }}
      lastFm={lastFm === undefined ? undefined : lastFmReturns[lastFm] ?? lastFmReturns.error}
      passwordChanged={changePassword.isSuccess}
    />
  )
}
