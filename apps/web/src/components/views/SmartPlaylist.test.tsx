import type { PlaylistDetail } from '@squirmy/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { playlists } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const [base] = playlists
/** A smart playlist of the user's: its songs come from its rules. */
const smart: PlaylistDetail = {
  ...base, id: '00000000-0000-4000-8400-0000000000cd', name: 'Jazz lately', isPublic: false, ownerId: currentUser.id, smart: true,
  rules: { source: 'library', match: 'all', conditions: [{ field: 'genre', op: 'contains', value: 'jazz' }], sort: 'random', limit: 50 },
}

function withSmart() {
  const fake = fakeServices()
  fake.api.userdata.playlist.mockImplementation(async (id: string) => (id === smart.id ? smart : { ...playlists[0], ownerId: currentUser.id }))
  return fake
}

describe('smart playlists', () => {
  it('makes one from rules, counting what they find as they are typed', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/library?filter=playlists', services)
    await userEvent.click(await screen.findByRole('button', { name: 'New smart playlist' }))
    const dialog = await screen.findByRole('dialog', { name: 'New smart playlist' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Jazz')
    // The rule is not finished: nothing is counted, and Create says which row to finish.
    expect(within(dialog).getByRole('status')).toHaveTextContent('Finish the rules to see what matches')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('Finish the marked rules, or remove them.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Genre value')).toHaveAttribute('aria-invalid', 'true')
    expect(api.userdata.createPlaylist).not.toHaveBeenCalled()

    await userEvent.type(within(dialog).getByLabelText('Genre value'), 'jazz')
    await userEvent.type(within(dialog).getByLabelText('Limit'), '30')
    expect(await within(dialog).findByText('12 songs, 45 min')).toBeInTheDocument()
    expect(api.userdata.previewSmartPlaylist).toHaveBeenLastCalledWith({
      source: 'library', match: 'all', conditions: [{ field: 'genre', op: 'contains', value: 'jazz' }], sort: 'random', limit: 30,
    })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New smart playlist' })).toBeNull())
    expect(api.userdata.createPlaylist).toHaveBeenCalledWith({
      name: 'Jazz', description: null, isPublic: false,
      rules: { source: 'library', match: 'all', conditions: [{ field: 'genre', op: 'contains', value: 'jazz' }], sort: 'random', limit: 30 },
    })
  })

  it('adds and removes rules and groups', async () => {
    const { services } = fakeServices()
    renderWithApp(<AppRoutes />, '/library?filter=playlists', services)
    await userEvent.click(await screen.findByRole('button', { name: 'New smart playlist' }))
    const dialog = await screen.findByRole('dialog', { name: 'New smart playlist' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add group' }))
    expect(within(dialog).getByRole('list', { name: 'Rules of the group' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove group' }))
    expect(within(dialog).queryByRole('list', { name: 'Rules of the group' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove rule' }))
    expect(within(dialog).getByText('No rules: every song in your library.')).toBeInTheDocument()
    expect(await within(dialog).findByText('12 songs, 45 min')).toBeInTheDocument()
  })

  it('shows its songs as a smart playlist, which nobody reorders or empties by hand', async () => {
    const { services } = withSmart()
    renderWithApp(<AppRoutes />, `/playlist/${smart.id}`, services)
    expect(await screen.findByRole('heading', { name: 'Jazz lately' })).toBeInTheDocument()
    expect(screen.getByText('Smart playlist')).toBeInTheDocument()
    const first = smart.items[0].track
    await userEvent.click(screen.getByRole('button', { name: `More options for ${first.title}` }))
    expect(await screen.findByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Remove from playlist' })).toBeNull()
  })

  it('is shared from its menu like any playlist', async () => {
    const { services, api } = withSmart()
    renderWithApp(<AppRoutes />, `/playlist/${smart.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share playlist' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Create link' }))
    expect(api.share.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'playlist', id: smart.id }))
  })

  it('edits its rules from its menu', async () => {
    const { services, api } = withSmart()
    const updatePlaylist = vi.fn(async (id: string, request: object) => ({ ...smart, id, ...request }))
    Object.assign(api.userdata, { updatePlaylist })
    renderWithApp(<AppRoutes />, `/playlist/${smart.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit rules' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit smart playlist' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Jazz lately')
    expect(within(dialog).getByLabelText('Genre value')).toHaveValue('jazz')
    expect(within(dialog).getByLabelText('Limit')).toHaveValue('50')
    await userEvent.clear(within(dialog).getByLabelText('Genre value'))
    await userEvent.type(within(dialog).getByLabelText('Genre value'), 'soul')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updatePlaylist).toHaveBeenCalledWith(smart.id, expect.objectContaining({
      rules: { ...smart.rules!, conditions: [{ field: 'genre', op: 'contains', value: 'soul' }] },
    })))
  })
})
