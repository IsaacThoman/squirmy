import { ApiError } from '@squirmy/client-core'
import {
  DuplicateLibraryRootDetails, queryKeys,
  type CreateLibraryRootRequest, type ScrobblingStatus, type ScrobbleTarget, type UpdateLibraryRootRequest, type UpdateUserSettings, type User, type UserSettings,
} from '@squirmy/contracts'
import { notifyManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useFolderListing } from '@/api/folders'
import { useScrobbling, useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { setSetupDone, setSignedInUser, useCurrentUser, useMe, useSetupStatus } from '@/auth/session'
import { LoginView, RegisterView, SetupAccountView, SetupDoneView, SetupLibraryView } from '@/components/auth/AuthViews'
import { isSettingsSection } from '@/components/layout/settings-sections'
import { SettingsView } from '@/components/views/SettingsView'
import { browserName, deviceName, webDevice } from '@/lib/device'
import { toast } from '@/lib/toast'
import { usePlayer } from '@/player/player-context'

const appPasswordsKey = ['app-passwords'] as const

/** Where Last.fm sends the browser back to, as `?lastfm=` on this page. */
const lastFmReturns: Record<string, { title: string; description?: string }> = {
  connected: { title: 'Connected to Last.fm' },
  denied: { title: 'Last.fm was not connected', description: 'The connection was not approved.' },
  invalid_state: { title: 'That Last.fm link expired', description: 'Start connecting again.' },
  error: { title: 'Last.fm did not answer', description: 'Try again in a moment.' },
}

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

export function SettingsPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  const logout = useLogout()
  const { controls } = usePlayer()
  const [params] = useSearchParams()
  const { section } = useParams()
  const navigate = useNavigate()
  const settings = useUserSettings().data
  const scrobbling = useScrobbling().data
  const update = useSettingsUpdate()
  const connections = useScrobbleConnections()
  const [name, setName] = useState(browserName)
  const lastFmReturn = params.get('lastfm')
  useEffect(() => {
    if (lastFmReturn === null) return
    const message = lastFmReturns[lastFmReturn] ?? lastFmReturns.error
    toast(message)
    void navigate('/settings/scrobbling', { replace: true })
  }, [lastFmReturn, navigate])
  const passwords = useQuery({ queryKey: appPasswordsKey, queryFn: () => api.auth.appPasswords(), enabled: section === 'app-passwords' })
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
  if (lastFmReturn !== null) return null
  if (!isSettingsSection(section)) return <Navigate to="/settings/appearance" replace />
  return (
    <SettingsView
      key={section}
      section={section}
      user={user}
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
      onCreateAppPassword={name => createPassword.mutateAsync({ name })}
      onRevokeAppPassword={id => revokePassword.mutateAsync(id)}
      onChangePassword={request => changePassword.mutateAsync(request)}
      onRename={user.role === 'admin' ? displayName => rename.mutateAsync(displayName) : undefined}
      onLogout={logout}
    />
  )
}

/** Signing in only updates the session; the signed-out guard then moves on to `next`. */
function useSignedIn() {
  const queryClient = useQueryClient()
  return (user: User) => setSignedInUser(queryClient, user)
}

export function LoginPage() {
  const api = useApi()
  const { data: status } = useSetupStatus()
  const signedIn = useSignedIn()
  const login = useMutation({ mutationFn: api.auth.login, onSuccess: response => signedIn(response.user), meta: { inline: true } })
  return (
    <LoginView
      serverName={status!.serverName}
      version={status!.version}
      inviteRequired={status!.registrationRequiresInvite}
      onSubmit={credentials => login.mutateAsync({ ...credentials, device: webDevice() })}
    />
  )
}

export function RegisterPage() {
  const api = useApi()
  const [params] = useSearchParams()
  const { data: status } = useSetupStatus()
  const signedIn = useSignedIn()
  const register = useMutation({ mutationFn: api.auth.register, onSuccess: response => signedIn(response.user), meta: { inline: true } })
  return (
    <RegisterView
      serverName={status!.serverName}
      inviteCode={params.get('invite') ?? ''}
      inviteRequired={status!.registrationRequiresInvite}
      onSubmit={request => register.mutateAsync({ ...request, device: webDevice() })}
    />
  )
}

export type SetupStep = 'account' | 'library' | 'done'

/**
 * The first-run wizard. Creating the admin signs in, so the later steps are admin pages
 * that survive a reload: `/setup`, `/setup/library`, `/setup/done`.
 */
export function SetupPage({ step }: { step: SetupStep }) {
  const { data: status } = useSetupStatus()
  const { data: user } = useMe()
  if (status!.needsSetup) return step === 'account' ? <SetupAccount /> : <Navigate to="/setup" replace />
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  // Creating the admin lands here: the account exists, so the wizard moves on to the music.
  if (step === 'account') return <Navigate to="/setup/library" replace />
  return step === 'library' ? <SetupLibrary /> : <SetupDone />
}

function SetupAccount() {
  const api = useApi()
  const queryClient = useQueryClient()
  const setup = useMutation({
    mutationFn: api.auth.setup,
    onSuccess: response => notifyManager.batch(() => {
      setSignedInUser(queryClient, response.user)
      setSetupDone(queryClient)
    }),
    meta: { inline: true },
  })
  return <SetupAccountView onCreateAdmin={credentials => setup.mutateAsync({ ...credentials, device: webDevice() })} />
}

type DoneState = { paths: string[] } | null

// Scans report progress as events only to signed-in pages; the wizard asks again while one runs.
const SCANNING_REFRESH_MS = 2000

function SetupLibrary() {
  const api = useApi()
  const navigate = useNavigate()
  const [path, setPath] = useState<string>()
  const [alreadyAdded, setAlreadyAdded] = useState<string | null>(null)
  const listing = useFolderListing(path)
  const roots = useQuery({
    queryKey: queryKeys.adminRoots(),
    queryFn: () => api.library.roots(),
    select: page => page.items,
    refetchInterval: query => query.state.data?.items.some(root => root.scanning) ? SCANNING_REFRESH_MS : false,
  })
  const paths = roots.data?.map(root => root.path) ?? []
  const done = (state: DoneState) => navigate('/setup/done', { replace: true, state })
  const create = useMutation({ mutationFn: api.library.createRoot, meta: { inline: true } })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLibraryRootRequest }) => api.library.updateRoot(id, patch),
    onSuccess: () => roots.refetch(),
    meta: { inline: true },
  })
  const addFolder = async (request: CreateLibraryRootRequest) => {
    try {
      const root = await create.mutateAsync(request)
      done({ paths: [...paths, root.path] })
    } catch (error) {
      // A folder the server already has, often the one its configuration added at startup, is simply there.
      const existing = error instanceof ApiError && error.code === 'duplicate_root' ? DuplicateLibraryRootDetails.safeParse(error.details).data : undefined
      if (!existing) throw error
      setAlreadyAdded(existing.rootId)
      await roots.refetch()
    }
  }
  return (
    <SetupLibraryView
      roots={roots.data}
      alreadyAdded={alreadyAdded}
      path={listing.data?.path ?? path}
      listing={listing.data}
      listingError={listing.isError ? errorMessage(listing.error) : undefined}
      onBrowse={setPath}
      onAddFolder={addFolder}
      onMakeManaged={(id, patch) => update.mutateAsync({ id, patch })}
      onContinue={() => done(paths.length ? { paths } : null)}
    />
  )
}

function SetupDone() {
  const navigate = useNavigate()
  const state = useLocation().state as DoneState
  return <SetupDoneView folderPaths={state?.paths ?? []} onFinish={() => navigate('/', { replace: true })} />
}
