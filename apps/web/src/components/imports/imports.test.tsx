import type { ImportOptions } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { UploadPanel } from './UploadPanel'

const options: ImportOptions = { unavailable: null, maxFileBytes: 4 * 1024 ** 3, maxBytes: 64 * 1024 ** 3 }
const handlers = { onDrop: vi.fn(), onPick: vi.fn(), onStart: vi.fn(), onPause: vi.fn(), onCancel: vi.fn(), onClear: vi.fn(), onRemove: vi.fn() }

afterEach(() => vi.restoreAllMocks())

describe('upload panel', () => {
  it('says what an admin must do when there is no managed folder, instead of a drop zone', () => {
    renderWithApp(<UploadPanel options={{ ...options, unavailable: 'no_managed_root' }} isAdmin upload={null} reading={false} {...handlers} />)
    expect(screen.getByRole('heading', { name: 'Uploads have nowhere to go yet' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Library settings' })).toHaveAttribute('href', '/admin/library')
    expect(screen.queryByRole('heading', { name: 'Drop music here' })).toBeNull()
  })

  it('tells a member to ask an admin', () => {
    renderWithApp(<UploadPanel options={{ ...options, unavailable: 'import_root_not_set' }} isAdmin={false} upload={null} reading={false} {...handlers} />)
    expect(screen.getByText('An admin needs to choose which music folder uploads go to.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('lists what will be sent, refuses an upload over the limit, and shows why files were refused', () => {
    const upload = {
      phase: 'ready' as const, import: null, error: null, totalBytes: 70 * 1024 ** 3, sentBytes: 0,
      files: [
        { path: 'Blue Hour/01 Night Swimming.flac', size: 70 * 1024 ** 3, sent: 0, status: 'waiting' as const, reason: null },
        { path: 'Blue Hour/notes.txt', size: 10, sent: 0, status: 'rejected' as const, reason: 'unsupported_type' as const },
      ],
    }
    renderWithApp(<UploadPanel options={options} isAdmin upload={upload} reading={false} {...handlers} />)
    expect(screen.getByText('1 folder · 2 files · 70 GB · 1 cannot be uploaded')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('That is more than one upload may hold (64 GB)')
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
  })

  it('adds and removes files before anything is sent, and not once sending starts', async () => {
    // jsdom lays nothing out, so the virtual list would show no rows: its box is a screen's size.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
    const onRemove = vi.fn()
    const files = [
      { path: 'Blue Hour/01 Night Swimming.flac', size: 1000, sent: 0, status: 'waiting' as const, reason: null },
      { path: 'Blue Hour/02 Low Tide.flac', size: 1000, sent: 0, status: 'waiting' as const, reason: null },
    ]
    const upload = { phase: 'ready' as const, import: null, error: null, totalBytes: 2000, sentBytes: 0, files }
    const { unmount } = renderWithApp(<UploadPanel options={options} isAdmin upload={upload} reading={false} {...handlers} onRemove={onRemove} />)
    expect(screen.getByRole('button', { name: 'Add files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a folder' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Files to upload' })
    await userEvent.click(within(list).getByRole('button', { name: 'Remove 02 Low Tide.flac' }))
    expect(onRemove).toHaveBeenCalledWith('Blue Hour/02 Low Tide.flac')

    unmount()
    renderWithApp(<UploadPanel options={options} isAdmin upload={{ ...upload, phase: 'sending' }} reading={false} {...handlers} onRemove={onRemove} />)
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull()
  })
})
