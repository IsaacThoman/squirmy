import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { playlists } from '@/fixtures/catalog'
import { userSettings } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const [afterDark] = playlists

function ownPlaylist() {
  const fake = fakeServices()
  fake.api.userdata.playlist.mockImplementation(async () => ({ ...afterDark, ownerId: 'x' }))
  return fake
}

describe('finding and sorting in a playlist', () => {
  it('lists only the songs that match what is typed, and says when none do', async () => {
    const { services } = ownPlaylist()
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    const find = await screen.findByRole('searchbox', { name: 'Find in playlist' })
    const first = afterDark.items[0].track
    await userEvent.type(find, first.title)
    await waitFor(() => expect(screen.getByRole('button', { name: `More options for ${first.title}` })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: `More options for ${afterDark.items[1].track.title}` })).toBeNull()
    // The header still counts the whole playlist.
    expect(screen.getByText(new RegExp(`^${afterDark.items.length} songs`))).toBeInTheDocument()
    await userEvent.clear(find)
    await userEvent.type(find, 'nothing is called this')
    expect(await screen.findByRole('heading', { name: 'No songs match' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show every song' }))
    expect(await screen.findByRole('button', { name: `More options for ${afterDark.items[1].track.title}` })).toBeInTheDocument()
  })
})

describe('star ratings', () => {
  it('are rated from a song’s menu once the user shows them', async () => {
    const { services, api } = fakeServices()
    api.userdata.settings.mockResolvedValue({ ...userSettings, showRatings: true })
    // As the server sends them: every song says its rating, null when it has none.
    api.userdata.playlist.mockResolvedValue({ ...afterDark, items: afterDark.items.map(item => ({ ...item, track: { ...item.track, rating: null } })) })
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    const song = afterDark.items[0].track
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${song.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rating' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '4 stars' }))
    await waitFor(() => expect(api.userdata.rate).toHaveBeenCalledWith('track', song.id, 4))
    // The song shows its stars at once.
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${song.title}` }))
    expect(await screen.findByRole('menuitem', { name: 'Rating: 4 stars' })).toBeInTheDocument()
  })

  it('stay out of the menus by default: the heart is the one control', async () => {
    const { services } = fakeServices()
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${afterDark.items[0].track.title}` }))
    expect(await screen.findByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Rating/ })).toBeNull()
  })
})
