import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { playlists } from '@/fixtures/catalog'
import { currentUser, userSettings } from '@/fixtures/server'
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

/** The row of the song titled `title`. */
const row = (title: string) => screen.getByRole('button', { name: `More options for ${title}` }).closest('li')!
/** Picks it with Ctrl-click, on the row itself rather than one of its controls. */
const pick = (title: string) => fireEvent.click(row(title).querySelector('.grid')!, { ctrlKey: true })

describe('picked songs in a sorted or filtered playlist', () => {
  // The first and third by title, which are not the first and third as the playlist stores them.
  const byTitle = [...afterDark.items].sort((a, b) => a.track.title.localeCompare(b.track.title))
  const chosen = [byTitle[0], byTitle[2]]

  it('are the ones removed, whatever order the songs are listed in', async () => {
    const { services, api } = fakeServices()
    const own = { ...afterDark, ownerId: currentUser.id }
    api.userdata.playlist.mockResolvedValue(own)
    const removePlaylistItem = vi.fn(async (_playlistId: string, _itemId: string) => own)
    Object.assign(api.userdata, { removePlaylistItem })
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    await userEvent.click(await screen.findByRole('combobox', { name: 'Sort songs' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Title' }))
    for (const item of chosen) pick(item.track.title)
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Selected songs' })).getByRole('button', { name: 'Remove from playlist' }))
    await waitFor(() => expect(removePlaylistItem).toHaveBeenCalledTimes(2))
    expect(removePlaylistItem.mock.calls.map(([, itemId]) => itemId).sort()).toEqual(chosen.map(item => item.itemId).sort())
  })

  it('leave the selection once a find no longer lists them', async () => {
    const { services } = ownPlaylist()
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    const find = await screen.findByRole('searchbox', { name: 'Find in playlist' })
    for (const item of chosen) pick(item.track.title)
    expect(screen.getByRole('toolbar', { name: 'Selected songs' })).toHaveTextContent('2 songs selected')
    // Typed without a press on the field, which would let go of the whole selection.
    fireEvent.change(find, { target: { value: chosen[0].track.title } })
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Selected songs' })).toHaveTextContent('1 song selected'))
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
