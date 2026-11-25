import { ApiError } from '@squirmy/client-core'
import { DuplicateLibraryRootDetails, queryKeys, type CreateLibraryRootRequest, type UpdateLibraryRootRequest, type User } from '@squirmy/contracts'
import { notifyManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useFolderListing } from '@/api/folders'
import { useApi } from '@/api/services'
import { setSetupDone, setSignedInUser, useMe, useSetupStatus, useSignInNotice } from '@/auth/session'
import { LoginView, RegisterView, SetupAccountView, SetupDoneView, SetupLibraryView } from '@/components/auth/AuthViews'
import { webDevice } from '@/lib/device'

/** Signing in only updates the session; the signed-out guard then moves on to `next`. */
function useSignedIn() {
  const queryClient = useQueryClient()
  return (user: User) => setSignedInUser(queryClient, user)
}

export function LoginPage() {
  const api = useApi()
  const { data: status } = useSetupStatus()
  const signedIn = useSignedIn()
  const notice = useSignInNotice()
  const login = useMutation({ mutationFn: api.auth.login, onSuccess: response => signedIn(response.user), meta: { inline: true } })
  return (
    <LoginView
      serverName={status!.serverName}
      version={status!.version}
      inviteRequired={status!.registrationRequiresInvite}
      notice={notice}
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
      version={status!.version}
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
