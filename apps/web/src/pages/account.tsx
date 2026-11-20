import { ApiError } from '@squirmy/client-core'
import { queryKeys, type CreateLibraryRootRequest, type User, type UserSettings } from '@squirmy/contracts'
import { notifyManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { useLogout } from '@/auth/actions'
import { setSetupDone, setSignedInUser, useCurrentUser, useMe, useSetupStatus } from '@/auth/session'
import { LoginView, RegisterView, SetupAccountView, SetupDoneView, SetupLibraryView } from '@/components/auth/AuthViews'
import { SettingsView } from '@/components/views/SettingsView'
import { userSettings } from '@/fixtures/server'
import { webDevice } from '@/lib/device'
import { toast } from '@/lib/toast'

const appPasswordsKey = ['app-passwords'] as const

export function SettingsPage() {
  const api = useApi()
  const queryClient = useQueryClient()
  const user = useCurrentUser()
  const logout = useLogout()
  // The user settings route arrives with the userdata module; until then they stay in this page.
  const [settings, setSettings] = useState<UserSettings>(userSettings)
  const passwords = useQuery({ queryKey: appPasswordsKey, queryFn: () => api.auth.appPasswords() })
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
    <SettingsView
      user={user}
      settings={settings}
      onSettingsChange={patch => setSettings(current => ({ ...current, ...patch }))}
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

type DoneState = { path?: string; note?: string } | null

function SetupLibrary() {
  const api = useApi()
  const navigate = useNavigate()
  const [path, setPath] = useState<string>()
  const listing = useQuery({
    queryKey: ['admin', 'fs', path ?? null],
    queryFn: () => api.admin.directories({ path }),
    retry: false,
    meta: { silent: true },
  })
  const done = (state: DoneState) => navigate('/setup/done', { replace: true, state })
  const create = useMutation({
    mutationFn: (request: CreateLibraryRootRequest) => api.library.createRoot(request),
    meta: { inline: true },
  })
  const addFolder = async (request: CreateLibraryRootRequest) => {
    try {
      await create.mutateAsync(request)
      done({ path: request.path })
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error
      done({ note: 'This server cannot add library folders yet, so setup skipped this step. Add the folder later from Admin → Library.' })
    }
  }
  return (
    <SetupLibraryView
      path={listing.data?.path ?? path}
      listing={listing.data}
      listingError={listing.isError ? errorMessage(listing.error) : undefined}
      onBrowse={setPath}
      onAddFolder={addFolder}
      onSkip={() => done(null)}
    />
  )
}

function SetupDone() {
  const navigate = useNavigate()
  const state = useLocation().state as DoneState
  return <SetupDoneView folderPath={state?.path} note={state?.note} onFinish={() => navigate('/', { replace: true })} />
}
