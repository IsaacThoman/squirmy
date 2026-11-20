import type { ImportOptions } from '@squirmy/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { UploadPanel } from './UploadPanel'

const options: ImportOptions = { unavailable: null, maxFileBytes: 4 * 1024 ** 3, maxBytes: 64 * 1024 ** 3 }
const handlers = { onDrop: vi.fn(), onPick: vi.fn(), onStart: vi.fn(), onPause: vi.fn(), onCancel: vi.fn(), onClear: vi.fn() }

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
    expect(screen.getByText('1 folder · 2 files · 70 GB · 1 not taken')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('That is more than one upload may hold (64 GB)')
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
  })
})
