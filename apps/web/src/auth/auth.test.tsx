import { ApiError } from '@squirmy/client-core'
import { queryKeys } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { users } from '@/fixtures/server'
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

describe('account', () => {
  it('shows a new app password once and revokes after confirming', async () => {
    const { services, api } = fakeServices()
    renderWithApp(app, '/settings', services)
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Phone')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByLabelText('App password')).toHaveValue('sq-secret')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0])
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(api.auth.deleteAppPassword).toHaveBeenCalled())
  })

  it('puts a wrong current password on its field', async () => {
    const { services, api } = fakeServices()
    api.auth.changePassword.mockRejectedValueOnce(new ApiError(403, 'invalid_credentials', 'The current password is wrong'))
    renderWithApp(app, '/settings', services)
    await userEvent.click(await screen.findByRole('button', { name: 'Change password' }))
    await userEvent.type(screen.getByLabelText('Current password'), 'nope')
    await userEvent.type(screen.getByLabelText('New password'), 'a new password')
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a new password')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('The current password is wrong')).toBeInTheDocument()
  })
})

describe('realtime', () => {
  it('refreshes invalidated queries and says when the connection is down', async () => {
    const { services, socket } = fakeServices()
    const { queryClient } = renderWithApp(app, '/', services)
    await screen.findByRole('heading', { name: 'Listen now' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    act(() => socket.serverEmit('invalidate', { keys: [queryKeys.adminUsers()] }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.adminUsers() })

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
