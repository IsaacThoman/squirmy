import { ShieldOff } from 'lucide-react'
import { Suspense } from 'react'
import { Link, Navigate, Outlet, useLocation, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { SplashView, UnreachableView } from '@/components/auth/AuthViews'
import { Page } from '@/components/layout/Page'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { LibraryProvider } from '@/player/LibraryProvider'
import { OnDemandProvider } from '@/player/OnDemandProvider'
import { PlayerProvider } from '@/player/PlayerProvider'
import { RealtimeProvider } from '@/realtime/RealtimeProvider'
import { CurrentUserContext, safeNext, useCurrentUser, useMe, useSetupStatus } from './session'

/** Waits for the server's setup status and the session before showing any route. */
export function Bootstrap() {
  const status = useSetupStatus()
  const me = useMe()
  if (status.data === undefined || me.data === undefined) {
    const error = status.error ?? me.error
    if (!error) return <SplashView />
    return <UnreachableView message={errorMessage(error)} onRetry={() => { void status.refetch(); void me.refetch() }} />
  }
  return <Outlet />
}

/** Until the first admin exists, every route is the setup wizard. */
export function RequireSetup() {
  const { data: status } = useSetupStatus()
  return status?.needsSetup ? <Navigate to="/setup" replace /> : <Outlet />
}

/** Sign-in and registration: a signed-in user goes on to where they were heading. */
export function SignedOutOnly() {
  const { data: user } = useMe()
  const [params] = useSearchParams()
  return user ? <Navigate to={safeNext(params.get('next'))} replace /> : <Outlet />
}

/** The app itself, with the user's socket, session and library. Signed-out visitors sign in first and then come back here. */
export function SignedInOnly() {
  const { data: user } = useMe()
  const location = useLocation()
  if (!user) {
    const next = location.pathname + location.search
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />
  }
  return (
    <CurrentUserContext value={user}>
      <RealtimeProvider>
        <Suspense fallback={<SplashView />}>
          <PlayerProvider>
            <OnDemandProvider>
              <LibraryProvider><Outlet /></LibraryProvider>
            </OnDemandProvider>
          </PlayerProvider>
        </Suspense>
      </RealtimeProvider>
    </CurrentUserContext>
  )
}

export function AdminOnly() {
  const user = useCurrentUser()
  if (user.role === 'admin') return <Outlet />
  return (
    <Page>
      <EmptyState
        icon={<ShieldOff />}
        title="Admins only"
        description="Ask an admin of this server if you need something changed."
        action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>}
      />
    </Page>
  )
}
