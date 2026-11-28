import type { HygieneFile } from '@squirmy/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const blueHour = album('blue-hour')
const copy: HygieneFile = {
  id: '00000000-0000-4000-8000-000000000001', album: blueHour.title, albumId: blueHour.id, title: 'Blue Morning', artist: 'Mira Vale',
  path: '/music/Blue Hour/Blue Morning.flac', folder: '/music/Blue Hour', codec: 'flac', container: 'FLAC',
  lossless: true, bitrate: 800_000, bitDepth: 16, sampleRate: 44_100, durationMs: 3000, managed: false, revision: 'one',
}

describe('library hygiene screens', () => {
  it('opens tag editing from an admin album menu and sends only changed fields for writable files', async () => {
    const { api, services } = fakeServices()
    api.admin.albumTags.mockResolvedValue({ covers: [], tracks: [
      { id: '00000000-0000-4000-8000-000000000001', path: copy.path, group: 'group', revision: 'one', matchLocked: false, reason: null,
        tags: { title: 'blue morning', album: blueHour.title, artist: 'Mira Vale', track: 7 } },
      { id: '00000000-0000-4000-8000-000000000002', path: '/readonly/song.flac', group: 'other', revision: 'two', matchLocked: true,
        reason: 'This file is in a read-only folder.', tags: { title: 'keep untouched' } },
    ] })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit tags…' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit tags' })
    expect(await within(editor).findByText('This file is in a read-only folder.')).toBeInTheDocument()
    await userEvent.click(within(editor).getByRole('button', { name: 'Capitalize titles' }))
    await userEvent.click(within(editor).getByRole('button', { name: 'Renumber by disc' }))
    await userEvent.type(within(editor).getByLabelText('Genre'), 'Jazz; Ambient')
    await userEvent.click(within(editor).getByRole('button', { name: 'Save tags' }))
    await waitFor(() => expect(api.admin.editAlbumTags).toHaveBeenCalledWith(blueHour.id, {
      album: { genres: ['Jazz', 'Ambient'] },
      tracks: [{ id: '00000000-0000-4000-8000-000000000001', revision: 'one', tags: { title: 'Blue Morning', track: 1 } }],
    }))
  })

  it('keeps the tag editor out of the album menu for members', async () => {
    const { services } = fakeServices({ user: users[1] })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    expect(screen.queryByRole('menuitem', { name: 'Edit tags…' })).toBeNull()
  })

  it('confirms deletion of a managed copy while keeping the suggested lossless file', async () => {
    const { api, services } = fakeServices()
    const lossy = { ...copy, path: copy.path.replace('.flac', '.mp3'), id: '00000000-0000-4000-8000-000000000002', managed: true, lossless: false, bitrate: 128_000, revision: 'two' }
    api.admin.duplicates.mockResolvedValue({ nextCursor: null, items: [
      { id: 'tags:one', label: 'Blue Morning', reason: 'tags', files: [copy, lossy], bestId: copy.id },
    ] })
    renderWithApp(<AppRoutes />, '/admin/duplicates', services)
    expect(await screen.findByText('Suggested copy')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete copy…' }))
    const dialog = screen.getByRole('dialog', { name: 'Permanently delete this copy?' })
    expect(within(dialog).getByText(lossy.path)).toBeInTheDocument()
    expect(api.admin.removeDuplicate).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete copy' }))
    expect(api.admin.removeDuplicate).toHaveBeenCalledWith(lossy.id, { keepId: copy.id, reason: 'tags', revision: lossy.revision })
  })

  it('shows file-health results, exposes the server folder and requests a re-check', async () => {
    const { api, services } = fakeServices()
    api.admin.fileHealth.mockResolvedValue({ nextCursor: null, items: [
      { ...copy, status: 'decode_error', detail: 'Invalid frame', pending: false, checkedAt: '2026-11-28T01:30:00.000Z' },
    ] })
    renderWithApp(<AppRoutes />, '/admin/file-health', services)
    expect(await screen.findByText('Decode failed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show folder path' }))
    expect(screen.getByLabelText('Server folder path')).toHaveValue(copy.folder)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await userEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(api.admin.recheckFile.mock.calls[0]?.[0]).toBe(copy.id)
  })
})
