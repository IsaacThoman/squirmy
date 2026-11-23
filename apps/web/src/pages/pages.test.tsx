import { ApiError } from '@squirmy/client-core'
import { queryKeys } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, playlistDetail } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const routes: [string, string | RegExp][] = [
  ['/', 'Listen now'],
  ['/search', 'Search'],
  ['/search?q=soft', 'Search'],
  ['/library/albums', 'Library'],
  ['/library/artists', 'Library'],
  ['/library/songs', 'Library'],
  ['/library/playlists', 'Library'],
  ['/liked', 'Liked Songs'],
  ['/wantlist', 'Wantlist'],
  ['/album/00000000-0000-4000-8200-000000000001', 'Blue Hour'],
  ['/artist/00000000-0000-4000-8100-000000000001', 'Mira Vale'],
  ['/playlist/00000000-0000-4000-8400-000000000001', 'After Dark'],
  ['/imports', 'Add music'],
  ['/imports/00000000-0000-4000-8a00-000000000001', 'Import'],
  ['/admin/library', 'Admin'],
  ['/admin/reviews', 'Admin'],
  ['/admin/organize', 'Admin'],
  ['/admin/search-index', 'Admin'],
  ['/admin/users', 'Admin'],
  ['/admin/providers', 'Admin'],
  ['/admin/settings', 'Admin'],
  ['/admin/jobs', 'Admin'],
  ['/dev/kitchen-sink', 'Kitchen sink'],
  ['/dev/engine', 'Audio engine'],
  ['/nowhere', 'Nothing here'],
]

const LAZY_DEV_PAGE_MS = 15_000

const signedOut: [string, string][] = [
  ['/login', 'Sign in to Squirmy'],
  ['/register?invite=ABC', 'Join Squirmy'],
]

describe('pages', () => {
  it.each(routes)('%s renders', async (route, heading) => {
    renderWithApp(<AppRoutes />, route)
    // The dev pages are the largest lazy chunks, and under a full parallel run their first import can take a while.
    const wait = route.startsWith('/dev/') ? { timeout: LAZY_DEV_PAGE_MS } : undefined
    // "Nothing here" is the whole page, so it is the page's level 1 heading too.
    expect(await screen.findByRole('heading', { level: 1, name: heading }, wait)).toBeInTheDocument()
  }, LAZY_DEV_PAGE_MS + 2000)

  it('/wantlist goes home while the server has the wantlist off', async () => {
    renderWithApp(<AppRoutes />, '/wantlist', fakeServices({ status: { wantlistEnabled: false } }).services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Listen now' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Wantlist' })).not.toBeInTheDocument()
  })

  it.each(['/settings', '/settings/appearance'])('%s opens the settings dialog over the home page', async route => {
    renderWithApp(<AppRoutes />, route)
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    // The dialog is modal, so the page behind it is out of reach while it is open.
    expect(await screen.findByRole('heading', { level: 1, name: 'Listen now', hidden: true })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it.each(signedOut)('%s renders signed out', async (route, heading) => {
    renderWithApp(<AppRoutes />, route, fakeServices({ user: null }).services)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('/setup renders before the first admin exists', async () => {
    renderWithApp(<AppRoutes />, '/setup', fakeServices({ user: null, status: { needsSetup: true } }).services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome to Squirmy' })).toBeInTheDocument()
  })

  it.each(['/artist/not-a-uuid', '/album/01a2048d-b138', '/playlist/after-dark'])('%s, an id cut short, is “Nothing here” without asking the server', async route => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, route, services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeInTheDocument()
    expect(screen.queryByText('This page did not load')).toBeNull()
    expect(api.catalog.artist).not.toHaveBeenCalled()
    expect(api.catalog.album).not.toHaveBeenCalled()
    expect(api.userdata.playlist).not.toHaveBeenCalled()
  })
})

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

describe('deleting a playlist', () => {
  const afterDark = playlistDetail('00000000-0000-4000-8400-000000000001')!

  it('says what goes for a private playlist, and does not ask for it again', async () => {
    const { services, api, socket } = fakeServices()
    let finish: () => void = () => {}
    const deletePlaylist = vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = () => resolve({ ok: true }) }))
    Object.assign(api.userdata, { deletePlaylist })
    api.userdata.playlist.mockResolvedValue({ ...afterDark, isPublic: false, ownerId: (await api.auth.me()).id })
    renderWithApp(<><AppRoutes /><Where /></>, `/playlist/${afterDark.id}`, services)
    await screen.findByRole('heading', { level: 1, name: afterDark.name })
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete playlist' }))
    const dialog = await screen.findByRole('dialog', { name: `Delete “${afterDark.name}”?` })
    expect(dialog.textContent).toMatch(/No songs are removed from your library or your other playlists/)
    expect(dialog.textContent).not.toMatch(/goes away for everyone/)
    const asked = api.userdata.playlist.mock.calls.length
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    // The server tells every client the playlists changed before its answer arrives.
    act(() => socket.serverEmit('invalidate', { keys: [queryKeys.playlists()] }))
    await act(async () => finish())
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/library?filter=playlists'))
    act(() => socket.serverEmit('invalidate', { keys: [queryKeys.playlists()] }))
    // The library's list without it is all that says so.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.userdata.playlist).toHaveBeenCalledTimes(asked)
    expect(deletePlaylist).toHaveBeenCalledWith(afterDark.id)
  })

  it('says a public playlist goes for everyone', async () => {
    const { services, api } = fakeServices()
    api.userdata.playlist.mockResolvedValue({ ...afterDark, isPublic: true, ownerId: (await api.auth.me()).id })
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    await screen.findByRole('heading', { level: 1, name: afterDark.name })
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete playlist' }))
    expect((await screen.findByRole('dialog')).textContent).toMatch(/It is public, so it goes away for everyone who can see it/)
  })

  it('says in the confirmation why the server refused, and keeps the playlist', async () => {
    const { services, api } = fakeServices()
    api.userdata.playlist.mockResolvedValue({ ...afterDark, isPublic: false, ownerId: (await api.auth.me()).id })
    Object.assign(api.userdata, { deletePlaylist: vi.fn(async () => { throw new ApiError(503, 'unavailable', 'The server is busy.') }) })
    renderWithApp(<><AppRoutes /><Where /></>, `/playlist/${afterDark.id}`, services)
    await screen.findByRole('heading', { level: 1, name: afterDark.name })
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete playlist' }))
    const dialog = await screen.findByRole('dialog', { name: `Delete “${afterDark.name}”?` })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The server is busy.')
    expect(screen.getByTestId('where').textContent).toBe(`/playlist/${afterDark.id}`)
    // Cancelled, it asks afresh the next time.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete playlist' }))
    expect(within(await screen.findByRole('dialog')).queryByRole('alert')).toBeNull()
  })
})

describe('changing a playlist', () => {
  const afterDark = playlistDetail('00000000-0000-4000-8400-000000000001')!

  it('puts back a song the server refused to remove, and says so above the songs', async () => {
    const { services, api } = fakeServices()
    api.userdata.playlist.mockResolvedValue({ ...afterDark, ownerId: (await api.auth.me()).id })
    Object.assign(api.userdata, { removePlaylistItem: vi.fn(async () => { throw new ApiError(503, 'unavailable', 'The server is busy.') }) })
    renderWithApp(<AppRoutes />, `/playlist/${afterDark.id}`, services)
    const first = afterDark.items[0]!.track
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${first.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from playlist' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(`Couldn’t remove “${first.title}”. Try again.`)
    expect(await screen.findByRole('button', { name: `More options for ${first.title}` })).toBeInTheDocument()
  })
})

describe('adding to a playlist', () => {
  const afterDark = playlistDetail('00000000-0000-4000-8400-000000000001')!
  const blueHour = album('blue-hour')

  async function addFromAlbum(title: string, addPlaylistItems = vi.fn(async () => afterDark)) {
    const { services, api } = fakeServices()
    Object.assign(api.userdata, { addPlaylistItems })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to playlist' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: afterDark.name }))
    return addPlaylistItems
  }

  const inAfterDark = afterDark.items.map(item => item.track).find(item => blueHour.discs.some(disc => disc.tracks.some(each => each.id === item.id)))!
  const notInAfterDark = blueHour.discs[0].tracks.find(item => !afterDark.items.some(each => each.track.id === item.id))!

  it('adds a song the playlist does not have yet at once, and the entry says so', async () => {
    const add = await addFromAlbum(notInAfterDark.title)
    await waitFor(() => expect(add).toHaveBeenCalledWith(afterDark.id, { tracks: [{ trackId: notInAfterDark.id, albumId: blueHour.id }] }))
    expect(screen.queryByRole('dialog', { name: 'Already in playlist' })).toBeNull()
    expect(await screen.findByRole('menuitem', { name: `Added to ${afterDark.name}` })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('says on the entry why the server refused the song, and keeps the menu open to try again', async () => {
    const add = vi.fn(async () => { throw new ApiError(503, 'unavailable', 'The server is busy.') })
    await addFromAlbum(notInAfterDark.title, add)
    const item = await screen.findByRole('menuitem', { name: /After Dark/ })
    await waitFor(() => expect(item).toHaveTextContent('The server is busy.'))
    // The menu and its playlists submenu stay.
    expect(screen.getAllByRole('menu')).toHaveLength(2)
  })

  it('says in the dialog when Add anyway was refused, and stays', async () => {
    const add = vi.fn(async () => { throw new ApiError(503, 'unavailable', 'The server is busy.') })
    await addFromAlbum(inAfterDark.title, add)
    const dialog = await screen.findByRole('dialog', { name: 'Already in playlist' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add anyway' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The server is busy.')
    expect(screen.getByRole('dialog', { name: 'Already in playlist' })).toBeInTheDocument()
  })

  it('asks before adding a song a second time: Add anyway adds it again', async () => {
    const add = await addFromAlbum(inAfterDark.title)
    const dialog = await screen.findByRole('dialog', { name: 'Already in playlist' })
    expect(dialog.textContent).toContain(`“${inAfterDark.title}” is already in “${afterDark.name}”.`)
    expect(add).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add anyway' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith(afterDark.id, { tracks: [{ trackId: inAfterDark.id, albumId: blueHour.id }] }))
  })

  it('asks before adding a song a second time: Skip adds nothing', async () => {
    const add = await addFromAlbum(inAfterDark.title)
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Already in playlist' })).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Already in playlist' })).toBeNull())
    expect(add).not.toHaveBeenCalled()
  })

  it('skips only the songs already there when adding a whole album', async () => {
    const { services, api } = fakeServices()
    const addPlaylistItems = vi.fn(async () => afterDark)
    Object.assign(api.userdata, { addPlaylistItems })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await screen.findByRole('list', { name: 'Blue Hour tracks' })
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to playlist' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: afterDark.name }))
    const dialog = await screen.findByRole('dialog', { name: 'Already in playlist' })
    const tracks = blueHour.discs.flatMap(disc => disc.tracks)
    const repeated = tracks.filter(item => afterDark.items.some(each => each.track.id === item.id))
    expect(dialog.textContent).toContain(`${repeated.length} of these ${tracks.length} songs are already in “${afterDark.name}”.`)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(addPlaylistItems).toHaveBeenCalledWith(afterDark.id, {
      tracks: tracks.filter(item => !repeated.includes(item)).map(item => ({ trackId: item.id, albumId: blueHour.id })),
      skipDuplicates: true,
    }))
  })

  it('has the fixtures it needs: a Blue Hour song in After Dark and one not in it', () => {
    expect(inAfterDark).toBeDefined()
    expect(notInAfterDark).toBeDefined()
  })
})
