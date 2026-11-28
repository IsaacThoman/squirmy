import { ApiError } from '@squirmy/client-core'
import { queryKeys } from '@squirmy/contracts'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { users } from '@/fixtures/server'
import { setSigningOut } from '@/auth/session'
import { DOWN_AFTER_MS } from '@/realtime/RealtimeProvider'
import { fakeServices, root } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

const app = <><AppRoutes /><Where /></>
const where = () => screen.getByTestId('where').textContent

describe('route guards', () => {
  it('sends every route to the setup wizard until an admin exists', async () => {
    renderWithApp(app, '/library/albums', fakeServices({ user: null, status: { needsSetup: true } }).services)
    expect(await screen.findByRole('heading', { name: 'Welcome to Squirmy' })).toBeInTheDocument()
    expect(where()).toBe('/setup')
  })

  it('sends signed-out visitors to sign in, remembering where they were going', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(app, '/admin/users', services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(where()).toBe('/login?next=%2Fadmin%2Fusers')
    expect(screen.getByText('Squirmy 0.0.0')).toBeInTheDocument()

    api.auth.login.mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', 'Wrong username or password'))
    await userEvent.type(screen.getByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password')
    expect(where()).toBe('/login?next=%2Fadmin%2Fusers')

    await userEvent.clear(screen.getByLabelText('Password'))
    await userEvent.type(screen.getByLabelText('Password'), 'right password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Users & invites' })).toBeInTheDocument()
    expect(where()).toBe('/admin/users')
    expect(screen.getAllByText('Squirmy 0.0.0').length).toBeGreaterThan(0)
    expect((api.auth.login.mock.lastCall as unknown[] | undefined)?.[0]).toEqual(expect.objectContaining({ username: 'alex', device: expect.objectContaining({ kind: 'web' }) }))
  })

  it('asks for the authenticator code after a right password, and takes a recovery code there too', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(app, '/login', services)
    api.auth.login.mockRejectedValueOnce(new ApiError(401, 'two_factor_required', 'Enter the code', { challenge: 'challenge-1', expiresAt: '2026-11-28T12:05:00.000Z' }))
    await userEvent.type(await screen.findByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'right password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()

    api.auth.loginTwoFactor.mockRejectedValueOnce(new ApiError(401, 'invalid_code', 'That code is not right.'))
    await userEvent.type(screen.getByLabelText('Authentication code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('That code is not right.')).toBeInTheDocument()
    expect(where()).toBe('/login')

    await userEvent.clear(screen.getByLabelText('Authentication code'))
    await userEvent.type(screen.getByLabelText('Authentication code'), 'abcde-fghjk')
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(where()).toBe('/'))
    expect((api.auth.loginTwoFactor.mock.lastCall as unknown[] | undefined)?.[0]).toEqual(expect.objectContaining({ challenge: 'challenge-1', code: 'abcde-fghjk', device: expect.objectContaining({ kind: 'web' }) }))
  })

  it('signs in with a passkey when the server and the browser can', async () => {
    const passkeys = await import('@/lib/passkeys')
    vi.spyOn(passkeys, 'browserSupportsPasskeys').mockReturnValue(true)
    const get = vi.spyOn(passkeys, 'getPasskey').mockResolvedValue({ id: 'cred', rawId: 'cred', type: 'public-key', response: {}, clientExtensionResults: {} })
    const { services, api } = fakeServices({ user: null, status: { passkeysAvailable: true } })
    renderWithApp(app, '/login', services)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }))
    await waitFor(() => expect(where()).toBe('/'))
    expect(get).toHaveBeenCalledWith({ challenge: 'abc' })
    expect((api.auth.loginWithPasskey.mock.lastCall as unknown[] | undefined)?.[0]).toEqual(expect.objectContaining({ challenge: 'login-challenge', response: expect.objectContaining({ id: 'cred' }) }))
    vi.restoreAllMocks()
  })

  it('says nothing when the passkey prompt is closed, and offers no passkey where the server has none', async () => {
    const passkeys = await import('@/lib/passkeys')
    vi.spyOn(passkeys, 'browserSupportsPasskeys').mockReturnValue(true)
    vi.spyOn(passkeys, 'getPasskey').mockRejectedValue(Object.assign(new Error('closed'), { name: 'NotAllowedError' }))
    const { services, api } = fakeServices({ user: null, status: { passkeysAvailable: true } })
    renderWithApp(app, '/login', services)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.auth.loginWithPasskey).not.toHaveBeenCalled()
    cleanup()
    renderWithApp(app, '/login', fakeServices({ user: null }).services)
    await screen.findByRole('button', { name: 'Sign in' })
    expect(screen.queryByRole('button', { name: 'Sign in with a passkey' })).toBeNull()
    vi.restoreAllMocks()
  })

  it('goes back from the code to the password', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(app, '/login', services)
    api.auth.login.mockRejectedValueOnce(new ApiError(401, 'two_factor_required', 'Enter the code', { challenge: 'challenge-1', expiresAt: '2026-11-28T12:05:00.000Z' }))
    await userEvent.type(await screen.findByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'right password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
  })

  it('validates with the contract schema before calling the server', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(app, '/register?invite=CODE', services)
    await userEvent.type(await screen.findByLabelText('Username'), 'a b')
    await userEvent.type(screen.getByLabelText('Password'), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByText('Letters, numbers, dots, dashes and underscores only')).toBeInTheDocument()
    expect(screen.getByText('At least 8 characters')).toBeInTheDocument()
    expect(api.auth.register).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Invite code')).toHaveValue('CODE')
  })

  it('makes the invite optional when the server allows open registration', async () => {
    renderWithApp(app, '/register', fakeServices({ user: null, status: { registrationRequiresInvite: false } }).services)
    expect(await screen.findByLabelText('Invite code (optional)')).toBeInTheDocument()
  })

  it('keeps members out of admin pages', async () => {
    renderWithApp(app, '/admin/settings', fakeServices({ user: users[1] }).services)
    expect(await screen.findByRole('heading', { name: 'Admins only' })).toBeInTheDocument()
  })

  it('signs out when any request finds the session gone', async () => {
    const { services, api } = fakeServices()
    api.admin.jobs.mockRejectedValue(new ApiError(401, 'unauthorized', 'Sign in to continue'))
    renderWithApp(app, '/admin/jobs', services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(where()).toBe('/login?next=%2Fadmin%2Fjobs')
    // Not the visitor's doing, so sign-in says why it is there.
    expect(screen.getByText('Your session ended. Sign in again to keep listening.').closest('[role=status]')).toBeInTheDocument()
  })

  it('says the session ended when the server closes the socket and the session is gone', async () => {
    // A password changed in another browser, or an admin disabling the account: the server
    // closes this browser's socket, and the session check that follows is refused.
    const { services, api, socket } = fakeServices()
    renderWithApp(app, '/', services)
    await screen.findByRole('button', { name: 'Account, Alex Rivera' })
    api.auth.me.mockRejectedValue(new ApiError(401, 'unauthorized', 'Sign in to continue'))
    act(() => socket.serverEmit('disconnect', 'io server disconnect'))
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(screen.getByText('Your session ended. Sign in again to keep listening.').closest('[role=status]')).toBeInTheDocument()
  })

  it('says nothing on sign-in when the visitor simply is not signed in', async () => {
    renderWithApp(app, '/admin/jobs', fakeServices({ user: null }).services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(screen.queryByText(/Your session ended/)).toBeNull()
  })
})

describe('signing out', () => {
  afterEach(() => localStorage.clear())

  const logOut = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Account, Alex Rivera' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }))
  }

  it('signs this browser out when the server can’t be reached, and ends the session there later', async () => {
    const first = fakeServices()
    first.api.auth.logout.mockRejectedValueOnce(new ApiError(0, 'network_error', 'Failed to fetch'))
    const { unmount } = renderWithApp(app, '/', first.services)
    await logOut()
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(screen.getByText('You’re signed out on this browser. The server couldn’t be reached, so it ends the session once it can.').closest('[role=status]')).toBeInTheDocument()
    expect(first.api.auth.logout).toHaveBeenCalledOnce()
    unmount()

    // The next visit, the session cookie is still there: the server is told first, and nobody is signed in.
    const next = fakeServices()
    next.api.auth.logout.mockRejectedValueOnce(new ApiError(0, 'network_error', 'Failed to fetch'))
    const again = renderWithApp(app, '/', next.services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(next.api.auth.me).not.toHaveBeenCalled()
    expect(next.api.auth.logout).toHaveBeenCalledOnce()
    again.unmount()

    // Once the server has heard, the browser asks it who is signed in again.
    const reached = fakeServices({ user: null })
    renderWithApp(app, '/', reached.services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(reached.api.auth.logout).toHaveBeenCalledOnce()
    await waitFor(() => expect(localStorage.getItem('squirmy.signOutPending')).toBeNull())
    cleanup()
    const later = fakeServices({ user: null })
    renderWithApp(app, '/', later.services)
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(later.api.auth.me).toHaveBeenCalled()
    expect(later.api.auth.logout).not.toHaveBeenCalled()
  }, 15_000)

  it('says nothing about an ended session while this browser is the one signing out', async () => {
    const { services, api, socket } = fakeServices()
    // The server ends the session and closes the socket before the log-out's answer arrives.
    api.auth.logout.mockReturnValueOnce(new Promise(() => {}))
    renderWithApp(app, '/', services)
    await logOut()
    api.auth.me.mockRejectedValue(new ApiError(401, 'unauthorized', 'Sign in to continue'))
    act(() => socket.serverEmit('disconnect', 'io server disconnect'))
    expect(await screen.findByRole('heading', { name: 'Sign in to Squirmy' })).toBeInTheDocument()
    expect(screen.queryByText(/Your session ended/)).toBeNull()
    setSigningOut(false)
  })

  it('signs in again after an offline sign-out without asking the server to end the new session', async () => {
    const { services, api } = fakeServices()
    api.auth.logout.mockRejectedValueOnce(new ApiError(0, 'network_error', 'Failed to fetch'))
    renderWithApp(app, '/', services)
    await logOut()
    await userEvent.type(await screen.findByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'right password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(where()).toBe('/'))
    expect(localStorage.getItem('squirmy.signOutPending')).toBeNull()
  })
})

describe('setup wizard', () => {
  it('creates the admin, browses for a folder and adds it', async () => {
    const { services, api } = fakeServices({ user: null, status: { needsSetup: true } })
    api.library.roots.mockResolvedValue({ items: [], nextCursor: null })
    api.library.createRoot.mockRejectedValueOnce(new ApiError(409, 'nested_root', 'That folder overlaps the library root /home/alex'))
    renderWithApp(app, '/setup', services)
    await userEvent.type(await screen.findByLabelText('Username'), 'alex')
    await userEvent.type(screen.getByLabelText('Password'), 'correct horse')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByRole('heading', { name: 'Where is your music?' })).toBeInTheDocument()
    expect(where()).toBe('/setup/library')
    await userEvent.click(await screen.findByRole('button', { name: 'Music' }))
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/home/alex/Music'))
    await userEvent.click(screen.getByRole('button', { name: 'Add and scan' }))
    expect(await screen.findByText('That folder overlaps the library root /home/alex')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add and scan' }))

    expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeInTheDocument()
    expect(screen.getByText('/home/alex/Music')).toBeInTheDocument()
    expect(api.library.createRoot.mock.calls[1]![0]).toEqual({ name: 'Music', path: '/home/alex/Music', mode: 'read_only', watch: true })
    await userEvent.click(screen.getByRole('button', { name: 'Start listening' }))
    expect(where()).toBe('/')
  })

  it('starts from the folders the server already has', async () => {
    const { services, api } = fakeServices({ status: { needsSetup: false } })
    api.library.createRoot.mockRejectedValueOnce(new ApiError(409, 'duplicate_root', 'That folder is already a library root', { rootId: root.id }))
    renderWithApp(app, '/setup/library', services)
    const folder = await screen.findByRole('listitem', { name: 'Music' })
    expect(within(folder).getByText('/srv/music')).toBeInTheDocument()
    expect(within(folder).getByText('Read-only')).toBeInTheDocument()
    expect(within(folder).getByText(/^120 files · scanned/)).toBeInTheDocument()

    // Adding it again is not a failure: it is already there.
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Music' }))
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/home/alex/Music'))
    await userEvent.click(screen.getByRole('button', { name: 'Add and scan' }))
    expect(await within(folder).findByText('Already added')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add and scan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.click(within(folder).getByRole('button', { name: 'Let Squirmy organize it…' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Make managed' }))
    expect(api.library.updateRoot).toHaveBeenCalledWith(root.id, { mode: 'managed' })
    await userEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeInTheDocument()
    expect(screen.getByText('/srv/music')).toBeInTheDocument()
  })
})

// Settings are a dialog over the app. A dialog opened from it hides it from assistive
// technology, so while one is open the only dialog queries find is that one.
describe('account', () => {
  it('shows a new app password once and revokes after confirming', async () => {
    const { services, api } = fakeServices()
    renderWithApp(app, '/', services)
    await userEvent.click(await screen.findByRole('button', { name: 'Account, Alex Rivera' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    await userEvent.click(within(settings).getByRole('button', { name: 'App passwords' }))

    await userEvent.click(await within(settings).findByRole('button', { name: 'Create' }))
    const creating = await screen.findByRole('dialog', { name: 'New app password' })
    await userEvent.type(within(creating).getByLabelText('Name'), 'Phone')
    await userEvent.type(within(creating).getByLabelText('Your password'), 'correct horse')
    await userEvent.click(within(creating).getByRole('button', { name: 'Create' }))
    expect(await screen.findByLabelText('App password')).toHaveValue('sq-secret')
    expect((api.auth.createAppPassword.mock.lastCall as unknown[] | undefined)?.[0]).toEqual({ name: 'Phone', currentPassword: 'correct horse' })
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    await userEvent.click((await within(settings).findAllByRole('button', { name: 'Revoke' }))[0])
    await userEvent.click(within(await screen.findByRole('dialog', { name: /^Revoke/ })).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(api.auth.deleteAppPassword).toHaveBeenCalled())
  })

  it('puts a wrong current password on its field', async () => {
    const { services, api } = fakeServices()
    api.auth.changePassword.mockRejectedValueOnce(new ApiError(403, 'invalid_credentials', 'The current password is wrong'))
    renderWithApp(app, '/settings/account', services)
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(settings).getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(where()).toBe('/'))

    await userEvent.click(within(settings).getByRole('button', { name: 'Change password' }))
    const changing = await screen.findByRole('dialog', { name: 'Change password' })
    await userEvent.type(within(changing).getByLabelText('Current password'), 'nope')
    await userEvent.type(within(changing).getByLabelText('New password'), 'a new password')
    await userEvent.type(within(changing).getByLabelText('Repeat the new password'), 'a new password')
    await userEvent.click(within(changing).getByRole('button', { name: 'Change password' }))
    expect(await within(changing).findByText('The current password is wrong')).toBeInTheDocument()
    expect(within(changing).getByLabelText('Current password')).toBeInvalid()
    expect(within(changing).getByLabelText('New password')).toBeValid()
  })
})

describe('realtime', () => {
  it('refreshes invalidated queries and says when the connection is down', async () => {
    const { services, socket } = fakeServices()
    const { queryClient } = renderWithApp(app, '/', services)
    await screen.findByRole('heading', { name: 'Listen now' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    act(() => socket.serverEmit('invalidate', { keys: [queryKeys.adminUsers()] }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.adminUsers() }))

    vi.useFakeTimers()
    act(() => {
      socket.connected = false
      socket.serverEmit('disconnect', 'transport close')
    })
    act(() => vi.advanceTimersByTime(DOWN_AFTER_MS - 100))
    expect(screen.queryByText('Reconnecting to the server…')).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByText('Reconnecting to the server…')).toBeInTheDocument()
    act(() => socket.connect())
    expect(screen.queryByText('Reconnecting to the server…')).not.toBeInTheDocument()
    expect(invalidate).toHaveBeenLastCalledWith()
    vi.useRealTimers()
  })
})
