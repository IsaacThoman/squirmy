import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { renderWithApp } from '@/test/render'
import { fakeServices, uploadAlbum, uploadFiles } from '@/test/fake-services'

async function renderAt(route: string, fake = fakeServices()) {
  renderWithApp(<AppRoutes />, route, fake.services)
  await screen.findByRole('main', { hidden: true })
  return fake
}

const main = () => within(screen.getByRole('main'))

beforeEach(() => {
  localStorage.clear()
  // jsdom lays nothing out, so the virtual lists would show no rows: every box is a screen's size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(220)
})

describe('Your uploads', () => {
  it('lists uploaded albums, opens one to its songs, and deletes a song after asking', async () => {
    const fake = await renderAt('/uploads')
    const list = await main().findByRole('list', { name: 'Your uploads' })
    expect(within(list).getByRole('link', { name: uploadAlbum.album.title })).toHaveAttribute('href', `/album/${uploadAlbum.album.id}`)
    expect(list).toHaveTextContent('2 songs · 20 MB')

    await userEvent.click(within(list).getByRole('button', { name: `Show the songs of ${uploadAlbum.album.title}` }))
    const songs = await main().findByRole('list', { name: `Uploaded songs of ${uploadAlbum.album.title}` })
    expect(within(songs).getAllByRole('listitem')).toHaveLength(2)

    const title = uploadFiles[0]!.track!.title
    await userEvent.click(within(songs).getByRole('button', { name: `Delete ${title}` }))
    const dialog = await screen.findByRole('dialog', { name: `Delete “${title}”?` })
    expect(dialog).toHaveTextContent('for everyone who listens here. It can’t be undone.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete song' }))
    expect(fake.api.uploads.deleteFile).toHaveBeenCalledWith(uploadFiles[0]!.fileId)
    expect(await main().findByText('Deleted 1 song (10 MB) from the server.')).toBeInTheDocument()
  })

  it('deletes a whole album after asking, saying what it takes off the server', async () => {
    const fake = await renderAt('/uploads')
    const list = await main().findByRole('list', { name: 'Your uploads' })
    await userEvent.click(within(list).getByRole('button', { name: `More options for ${uploadAlbum.album.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete album' }))
    const dialog = await screen.findByRole('dialog', { name: `Delete “${uploadAlbum.album.title}”?` })
    expect(dialog).toHaveTextContent('This deletes 2 uploaded songs (20 MB) from the server, for everyone who listens here.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete album' }))
    expect(fake.api.uploads.deleteAlbum).toHaveBeenCalledWith(uploadAlbum.album.id)
    expect(await main().findByText('Deleted 2 songs (20 MB) from the server.')).toBeInTheDocument()
  })

  it('points someone with no uploads to Add music', async () => {
    const fake = fakeServices()
    fake.api.uploads.list.mockResolvedValue({ items: [], nextCursor: null })
    await renderAt('/uploads', fake)
    expect(await main().findByRole('heading', { name: 'You haven’t uploaded anything yet' })).toBeInTheDocument()
    expect(main().getByRole('link', { name: 'Add music' })).toHaveAttribute('href', '/imports')
  })
})

describe('the admin’s Uploads', () => {
  it('lists everyone’s uploads with who uploaded them, and filters by uploader', async () => {
    const fake = await renderAt('/admin/uploads')
    const list = await main().findByRole('list', { name: 'Uploads' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(`@${uploadAlbum.uploader!.username}`)
    expect(rows[1]).toHaveTextContent('Inbox')

    await userEvent.click(main().getByRole('combobox', { name: 'Uploaded by' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Inbox folder' }))
    expect(fake.api.uploads.adminList).toHaveBeenLastCalledWith(expect.objectContaining({ uploader: 'inbox' }))
  })

  it('deletes an inbox album as the inbox’s', async () => {
    const fake = await renderAt('/admin/uploads')
    const list = await main().findByRole('list', { name: 'Uploads' })
    const inbox = within(list).getAllByRole('listitem')[1]!
    await userEvent.click(within(inbox).getByRole('button', { name: `More options for ${uploadAlbum.album.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete album' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete album' }))
    expect(fake.api.uploads.adminDeleteAlbum).toHaveBeenCalledWith(uploadAlbum.album.id, { uploader: 'inbox' })
  })
})

describe('On this server', () => {
  it('lists the server’s albums with the Library’s view, without All, playlists or pins', async () => {
    const fake = await renderAt('/collection')
    expect(await screen.findByRole('heading', { level: 1, name: 'On this server' })).toBeInTheDocument()
    const chips = within(screen.getByRole('navigation', { name: 'Filters' }))
    expect(chips.getAllByRole('link').map(link => link.textContent)).toEqual(['Albums', 'Artists', 'Songs'])
    expect(chips.getByRole('link', { name: 'Songs' })).toHaveAttribute('href', '/collection?filter=songs')
    await main().findByRole('link', { name: uploadAlbum.album.title })
    expect(fake.api.catalog.collectionAlbums).toHaveBeenCalledWith(expect.objectContaining({ sort: 'recent' }))
    expect(fake.api.catalog.albums).not.toHaveBeenCalled()
    expect(main().getByPlaceholderText('Find on this server')).toBeInTheDocument()
  })
})
