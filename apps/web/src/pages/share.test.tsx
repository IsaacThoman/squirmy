import { ApiError } from '@squirmy/client-core'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { publicShare, shareLinks } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const blueHour = album('blue-hour')

describe('public share page', () => {
  it('shows the shared album to someone signed out, without the app around it', async () => {
    const { services, api } = fakeServices({ user: null })
    renderWithApp(<AppRoutes />, '/s/abc123', services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Blue Hour' })).toBeInTheDocument()
    expect(api.share.page).toHaveBeenCalledWith('abc123')
    // Not sent to sign in, and no sidebar or player.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByText(/^Album · 2024 · 2 songs, /)).toBeInTheDocument()
    const songs = within(screen.getByRole('list', { name: 'Blue Hour songs' }))
    expect(songs.getAllByRole('listitem')).toHaveLength(2)
    expect(songs.getByText('Not available')).toBeInTheDocument()
    expect(screen.getByText('30-second previews')).toBeInTheDocument()
    expect(screen.getByText('Shared from Squirmy')).toBeInTheDocument()
    expect(document.title).toBe('Blue Hour · Mira Vale')
  })

  it('plays a song through the URL the server gives for it, and only songs it holds', async () => {
    const { services, api } = fakeServices({ user: null })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    renderWithApp(<AppRoutes />, '/s/abc123', services)
    const songs = within(await screen.findByRole('list', { name: 'Blue Hour songs' }))
    expect(songs.queryByRole('button', { name: 'Play Glass City' })).not.toBeInTheDocument()
    await userEvent.click(songs.getByRole('button', { name: 'Play Night Swimming' }))
    await waitFor(() => expect(play).toHaveBeenCalled())
    expect(api.share.trackPlayback).toHaveBeenCalledWith('abc123', publicShare.tracks[0]!.id, { codecs: expect.any(String) })
    expect(document.querySelector('audio')!.getAttribute('src') ?? (document.querySelector('audio') as HTMLAudioElement).src).toContain('/api/v1/share/stream?key=k')
    play.mockRestore()
  })

  it('offers no playing when the server plays nothing for shared pages', async () => {
    const { services, api } = fakeServices({ user: null })
    api.share.page.mockResolvedValue({ ...publicShare, playback: 'off' })
    renderWithApp(<AppRoutes />, '/s/abc123', services)
    await screen.findByRole('heading', { level: 1, name: 'Blue Hour' })
    expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Listening isn’t available on this page/)).toBeInTheDocument()
  })

  it('says a link that does not work does not, the same for every reason', async () => {
    const { services, api } = fakeServices({ user: null })
    api.share.page.mockRejectedValue(new ApiError(404, 'share_not_found', 'This link does not work.'))
    renderWithApp(<AppRoutes />, '/s/gone', services)
    expect(await screen.findByRole('heading', { level: 1, name: 'This link doesn’t work' })).toBeInTheDocument()
  })
})

describe('sharing from the app', () => {
  it('makes a link from an album’s menu and shows it once to copy', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share album' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Create link' }))
    expect(api.share.create).toHaveBeenCalledWith({ kind: 'album', id: blueHour.id, albumId: null, expiresIn: '7d' })
    const created = within(await screen.findByRole('dialog', { name: 'Link created' }))
    expect(created.getByRole('textbox', { name: 'Share link' })).toHaveValue(`${window.location.origin}/s/fixture-token`)
  })

  it('offers no Share while the server has sharing off', async () => {
    const { services } = fakeServices({ status: { sharingEnabled: false } })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    expect(await screen.findByRole('menuitem', { name: 'Play next' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Share…' })).not.toBeInTheDocument()
  })

  it('shares a song from its row’s menu with the album it is on', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const first = blueHour.discs[0].tracks[0]!
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${first.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Share song' }))
    await userEvent.click(dialog.getByRole('combobox', { name: 'Link works for' }))
    await userEvent.click(await screen.findByRole('option', { name: '30 days' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Create link' }))
    expect(api.share.create).toHaveBeenCalledWith({ kind: 'track', id: first.id, albumId: first.album!.id, expiresIn: '30d' })
  })
})

describe('admin sharing page', () => {
  it('lists every link with who made it, and revokes one after asking', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/admin/sharing', services)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(shareLinks.length + 1)
    expect(within(table).getAllByText('sam')).toHaveLength(shareLinks.length)
    await userEvent.click(within(table).getAllByRole('button', { name: 'Revoke' })[0]!)
    const confirm = within(await screen.findByRole('dialog', { name: 'Revoke the link to “Blue Hour”?' }))
    await userEvent.click(confirm.getByRole('button', { name: 'Revoke' }))
    expect(api.share.adminRevoke).toHaveBeenCalledWith(shareLinks[0]!.id)
  })

  it('switches sharing and what shared pages play', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/admin/sharing', services)
    await userEvent.click(await screen.findByRole('switch', { name: 'Share links' }))
    expect(api.admin.updateSettings).toHaveBeenCalledWith({ sharingEnabled: false })
    await userEvent.click(screen.getByRole('combobox', { name: 'What a shared page plays' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Whole songs' }))
    expect(api.admin.updateSettings).toHaveBeenCalledWith({ sharePlayback: 'full' })
  })
})
