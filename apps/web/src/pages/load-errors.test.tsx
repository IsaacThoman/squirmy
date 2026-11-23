import { ApiError } from '@squirmy/client-core'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

/** A refusal the query client does not retry, so the tests do not wait out its backoff. */
const refused = () => new ApiError(403, 'forbidden', 'The server said no.')

describe('a read that fails says so where its content would be, with a retry', () => {
  it('Add music: the upload panel fails on its own, and the imports list still shows', async () => {
    const fake = fakeServices()
    fake.api.imports.options.mockRejectedValueOnce(refused())
    renderWithApp(<AppRoutes />, '/imports', fake.services)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Uploading did not load')
    expect(await screen.findByRole('link', { name: 'Blue Hour' })).toBeInTheDocument()
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Drop music here' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Add music: a failed imports list leaves the upload panel usable', async () => {
    const fake = fakeServices()
    fake.api.imports.list.mockRejectedValueOnce(refused())
    renderWithApp(<AppRoutes />, '/imports', fake.services)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your imports did not load')
    expect(await screen.findByRole('heading', { name: 'Drop music here' })).toBeInTheDocument()
  })

  it('Admin: server settings', async () => {
    const fake = fakeServices()
    fake.api.admin.settings.mockRejectedValueOnce(refused())
    renderWithApp(<AppRoutes />, '/admin/settings', fake.services)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The server settings did not load')
    expect(alert).toHaveTextContent('The server said no.')
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Server name')).toBeInTheDocument()
  })

  it('Admin: users fail while invites still list', async () => {
    const fake = fakeServices()
    fake.api.admin.users.mockRejectedValueOnce(refused())
    renderWithApp(<AppRoutes />, '/admin/users', fake.services)
    expect(await screen.findByRole('alert')).toHaveTextContent('The users did not load')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('Admin: providers fail while the policy still shows', async () => {
    const fake = fakeServices()
    fake.api.acquisition.providers.mockRejectedValueOnce(refused())
    renderWithApp(<AppRoutes />, '/admin/providers', fake.services)
    expect(await screen.findByRole('alert')).toHaveTextContent('The providers did not load')
    expect(await screen.findByRole('switch', { name: 'Prefer lossless' })).toBeInTheDocument()
  })

  it('Admin: library folders', async () => {
    const fake = fakeServices()
    fake.api.library.roots.mockRejectedValue(refused())
    renderWithApp(<AppRoutes />, '/admin/library', fake.services)
    expect(await screen.findByText('The folders did not load')).toBeInTheDocument()
  })

  it('Settings: playback, scrobbling and app passwords', async () => {
    const fake = fakeServices()
    fake.api.userdata.settings.mockRejectedValue(refused())
    fake.api.scrobble.status.mockRejectedValue(refused())
    fake.api.auth.appPasswords.mockRejectedValue(refused())
    renderWithApp(<AppRoutes />, '/settings/playback', fake.services)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your playback settings did not load')
    // What does not depend on the failed read stays.
    expect(within(dialog).getByLabelText('This browser’s name')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Scrobbling' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your scrobbling connections did not load')
    await userEvent.click(within(dialog).getByRole('button', { name: 'App passwords' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your app passwords did not load')
  })
})
