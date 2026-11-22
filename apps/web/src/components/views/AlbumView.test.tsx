import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

describe('album page', () => {
  it('offers to get an album that plays on demand', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${album('low-tide').id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Get this album' }))
    expect(api.acquisition.acquireAlbum).toHaveBeenCalledWith(album('low-tide').id)
  })

  it('tells someone who may not fetch music why it does not play', async () => {
    const robin = users[2]!
    renderWithApp(<AppRoutes />, `/album/${album('low-tide').id}`, fakeServices({ user: robin }).services)
    expect(await screen.findByText(/fetch missing music\. (It is on|You can add it to) your Wantlist/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get this album' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Play Low Tide' })).toBeDisabled()
  })

  it('says nothing of the Wantlist while the server has it off', async () => {
    const robin = users[2]!
    renderWithApp(<AppRoutes />, `/album/${album('low-tide').id}`, fakeServices({ user: robin, status: { wantlistEnabled: false } }).services)
    expect(await screen.findByText(/fetch missing music\.$/)).toBeInTheDocument()
    expect(screen.queryByText(/Wantlist/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
  })

  it('opens Fix match from the menu for admins', async () => {
    renderWithApp(<AppRoutes />, `/album/${album('blue-hour').id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Fix match…' }))
    expect(await screen.findByRole('heading', { name: 'Fix match' })).toBeInTheDocument()
  })

  it('has no Fix match for members', async () => {
    renderWithApp(<AppRoutes />, `/album/${album('blue-hour').id}`, fakeServices({ user: users[1] }).services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    expect(await screen.findByRole('menuitem', { name: 'Play next' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Fix match…' })).toBeNull()
  })
})
