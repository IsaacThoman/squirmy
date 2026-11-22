import type { CatalogIndexStatus, MatchCandidate, MatchFile, OrganizeBatch, OrganizeBatchSummary } from '@squirmy/contracts'
import { DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TAGS_NOT_REVERTED } from '@squirmy/contracts'
import { ApiError } from '@squirmy/client-core'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { root, templateInfo } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { LibraryAdmin } from './LibraryAdmin'
import { CandidateComparison } from './MatchCompare'
import { OrganizeAdmin } from './OrganizeAdmin'
import { SearchIndexAdmin } from './SearchIndexAdmin'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ok = () => vi.fn(async () => ({ ok: true }))

function renderLibrary(overrides: Partial<Parameters<typeof LibraryAdmin>[0]> = {}) {
  const props = {
    roots: [root], stats: undefined, openReviews: 0, progress: {}, templateInfo,
    folders: { path: '/srv', listing: { path: '/srv', parent: '/', directories: [] }, error: undefined, onBrowse: vi.fn() },
    onScan: ok(), onAdd: ok(), onUpdate: ok(), onRemove: ok(), onFixMatch: vi.fn(),
    ...overrides,
  }
  renderWithApp(<LibraryAdmin {...props} />)
  return props
}

describe('library admin', () => {
  it('says plainly that removing a folder leaves the files alone', async () => {
    const props = renderLibrary()
    await userEvent.click(screen.getByRole('button', { name: 'More options for Music' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove folder…' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Nothing on disk is touched')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove folder' }))
    expect(props.onRemove).toHaveBeenCalledWith(root.id)
  })

  it('explains managed folders before making one managed', async () => {
    const props = renderLibrary()
    await userEvent.click(screen.getByRole('button', { name: 'More options for Music' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Let Squirmy organize this folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('heading', { name: 'Let Squirmy manage Music?' })).toBeInTheDocument()
    expect(props.onUpdate).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Make managed' }))
    expect(props.onUpdate).toHaveBeenCalledWith(root.id, { name: 'Music', mode: 'managed', watch: true, enabled: true })
  })

  it('edits a managed folder\'s naming template, with an example from the server\'s tokens', async () => {
    const managed = { ...root, mode: 'managed' as const }
    const onUpdate = vi.fn().mockRejectedValueOnce(new ApiError(400, 'invalid_request', 'The file name must end with .{ext}', [{ code: 'custom', path: ['template'], message: 'The file name must end with .{ext}' }]))
    renderLibrary({ roots: [managed], onUpdate })
    await userEvent.click(screen.getByRole('button', { name: 'More options for Music' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
    const field = screen.getByLabelText('Naming template')
    expect(field).toHaveValue(DEFAULT_ORGANIZE_TEMPLATE)
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Mira Vale/Blue Hour (2019)/2-03 Paper Boats.flac')).toBeInTheDocument()
    expect(screen.getByText('{albumartist}')).toBeInTheDocument()
    expect(screen.getByText('The album title')).toBeInTheDocument()

    await userEvent.clear(field)
    await userEvent.type(field, '{{artist}/{{title}')
    expect(screen.getByText('Mira Vale feat. Lune Park/Paper Boats')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The file name must end with .{ext}')).toBeInTheDocument()
    expect(onUpdate).toHaveBeenLastCalledWith(root.id, { name: 'Music', mode: 'managed', watch: true, enabled: true, template: '{artist}/{title}' })
    await userEvent.type(field, '.{{ext}')
    expect(screen.queryByText('The file name must end with .{ext}')).toBeNull()
    expect(screen.getByText('Mira Vale feat. Lune Park/Paper Boats.flac')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    expect(field).toHaveValue(DEFAULT_ORGANIZE_TEMPLATE)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).toHaveBeenLastCalledWith(root.id, { name: 'Music', mode: 'managed', watch: true, enabled: true })
  })

  it('opens a folder\'s editor from a link', () => {
    renderLibrary({ roots: [{ ...root, mode: 'managed' }], editRootId: root.id })
    expect(screen.getByRole('dialog', { name: 'Edit Music' })).toBeInTheDocument()
    expect(screen.getByLabelText('Naming template')).toBeInTheDocument()
  })

  it('shows live scan progress', () => {
    renderLibrary({ progress: { [root.id]: { rootId: root.id, phase: 'probing', processed: 30, total: 120 } } })
    expect(screen.getByRole('progressbar', { name: 'Reading tags in Music' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('30 of 120')).toBeInTheDocument()
  })

  it('counts the collection apart from the provider cache, and says so on the folder too', () => {
    const stats = { artists: 0, albums: 0, tracks: 0, files: 0, bytes: 0, durationMs: 0, matched: 0, unmatched: 0, inReview: 0, pending: 0, missing: 0 }
    const cache = { cachedFiles: 110, cachedBytes: 970 * 1024 ** 2, pinnedBytes: 0, limitBytes: 0 }
    renderLibrary({ roots: [{ ...root, fileCount: 110, cachedFileCount: 110 }], stats, cache })
    expect(screen.getByText(/The 110 files \(970 MB\) fetched for playing are cache/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Providers' })).toHaveAttribute('href', '/admin/providers')
    expect(screen.getByText(/0 in the collection · 110 cached/)).toBeInTheDocument()
  })
})

describe('match comparison', () => {
  const file = (n: number, title: string, durationMs: number): MatchFile => ({
    id: id(n), relPath: `okc/track${n}.flac`, title, artist: 'Radiohead', disc: null, track: n, durationMs, status: 'review', locked: false,
  })
  const candidate: MatchCandidate = {
    releaseMbid: id(90), releaseGroupMbid: id(91), title: 'OK Computer', artistCredit: 'Radiohead', date: '1997-05-21', country: 'GB', status: 'official',
    format: 'CD', label: 'Parlophone', catalogNumber: 'NODATA 02', barcode: null, disambiguation: '', trackCount: 2, discCount: 1, score: 0.7,
    breakdown: { tracks: 0.5, files: 0.6, coverage: 0.6, title: 1, artist: 1, year: null },
    tracks: [
      { disc: 1, position: 1, title: 'Airbag', durationMs: 284_000, fileId: id(1), similarity: 0.95 },
      { disc: 1, position: 2, title: 'Paranoid Android', durationMs: 383_000, fileId: id(2), similarity: 0.4 },
    ],
    extraFileIds: [id(3)],
  }

  it('highlights titles and durations that differ, and files that fit no track', () => {
    renderWithApp(<CandidateComparison candidate={candidate} files={[file(1, 'airbag', 285_000), file(2, 'Track 02', 395_000), file(3, 'Bonus', 60_000)]} />)
    const marked = [...document.querySelectorAll('mark')].map(mark => mark.textContent)
    expect(marked).toEqual(['Track 02', '6:35', '6:23'])
    expect(screen.getByText(/\+0:12 on your file/)).toBeInTheDocument()
    expect(screen.getByText('Not on this release')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /MusicBrainz/ })).toHaveAttribute('href', `https://musicbrainz.org/release/${id(90)}`)
    expect(screen.getByText('Not compared')).toBeInTheDocument()
  })
})

describe('organize admin', () => {
  const counts = { planned: 0, applied: 0, failed: 0, skipped: 0, reverted: 0, notReverted: 0, sidecars: 0, unchanged: 0, untrusted: 0, tagsWritten: 0, tagsSkipped: 0 }
  const summary: OrganizeBatchSummary = {
    id: id(10), rootId: root.id, rootName: 'Inbox', status: 'applied', includeUnmatched: false, writeTags: true, template: '{album}/{title}.{ext}',
    counts: { ...counts, applied: 3, tagsWritten: 3 }, createdAt: '2026-11-20T10:00:00.000Z', appliedAt: '2026-11-20T10:01:00.000Z', revertedAt: null,
  }
  const move = (n: number, album: string) => ({ id: id(n), kind: 'audio' as const, from: `in/${n}.mp3`, to: `${album}/${n}.mp3`, status: 'planned' as const, reason: null })
  const preview: OrganizeBatch = {
    ...summary, id: id(11), status: 'planned', writeTags: false, counts: { ...counts, planned: 3, untrusted: 2 }, appliedAt: null, notice: null,
    albums: [
      { albumId: id(20), title: 'Discovery', artistCredit: 'Daft Punk', moves: [move(1, 'Discovery'), move(2, 'Discovery')] },
      { albumId: id(21), title: 'Blue Hour', artistCredit: 'Mira Vale', moves: [move(3, 'Blue Hour')] },
    ],
  }
  const props = () => ({
    roots: [{ ...root, mode: 'managed' as const, name: 'Inbox' }], rootId: root.id, onRootChange: vi.fn(),
    preview, defaultTemplate: DEFAULT_ORGANIZE_TEMPLATE, running: null, history: [summary], onPreview: ok(), onApply: ok(), onRevert: ok(), onFixMatch: vi.fn(),
  })

  it('applies everything or only the albums still ticked', async () => {
    const handlers = props()
    renderWithApp(<OrganizeAdmin {...handlers} />)
    expect(screen.getByRole('heading', { name: '3 moves in 2 albums' })).toBeInTheDocument()
    expect(screen.getByText(/2 files not identified stay put/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply Blue Hour' }))
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 album' }))
    expect(handlers.onApply).toHaveBeenCalledWith([id(20)])
  })

  it('says which template a preview used and where to change it', () => {
    renderWithApp(<OrganizeAdmin {...props()} />)
    expect(screen.getByText('This folder’s template')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Change it in Library' })).toHaveAttribute('href', `/admin/library?edit=${root.id}`)
  })

  it('says that undo leaves written tags', async () => {
    const handlers = props()
    renderWithApp(<OrganizeAdmin {...handlers} />)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('3 files in Inbox move back to where they were')
    expect(dialog).toHaveTextContent(ORGANIZE_TAGS_NOT_REVERTED)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo batch' }))
    expect(handlers.onRevert).toHaveBeenCalledWith(summary)
  })

  it('blocks previews while a batch runs', () => {
    renderWithApp(<OrganizeAdmin {...props()} running={{ ...summary, status: 'applying', counts: { ...counts, planned: 6, applied: 2 } }} />)
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(screen.getByText('2 of 8')).toBeInTheDocument()
  })
})

describe('search index admin', () => {
  const status: CatalogIndexStatus = {
    ready: true, dumpDate: '2026-11-17T08:00:03.201Z', importedAt: '2026-11-18T08:00:00.000Z', counts: { artists: 9, albums: 11, recordings: 61 }, sizeBytes: 2_000_000,
    active: null,
    latest: {
      id: id(30), state: 'running', phase: 'download', source: null, dumpDate: null, recordingsPerArtist: null, bytesRead: 512 * 1024 * 1024, totalBytes: 2048 * 1024 * 1024,
      rowsRead: 1_200_000, error: null, startedAt: '2026-11-20T10:00:00.000Z', finishedAt: null,
    },
  }

  it('follows a running import and cancels it without dropping the index', async () => {
    const handlers = { onStart: ok(), onCancel: ok(), onRemove: ok() }
    renderWithApp(<SearchIndexAdmin status={status} starting={false} {...handlers} />)
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByText('512 MB of 2.0 GB · 1,200,000 songs read')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('The index in use stays as it is.')
    await userEvent.click(screen.getByRole('button', { name: 'Stop import' }))
    expect(handlers.onCancel).toHaveBeenCalled()
    expect(handlers.onRemove).not.toHaveBeenCalled()
  })

  it('validates the size before starting', async () => {
    const handlers = { onStart: ok(), onCancel: ok(), onRemove: ok() }
    renderWithApp(<SearchIndexAdmin status={{ ...status, ready: false, latest: null }} starting={false} {...handlers} />)
    await userEvent.click(screen.getByLabelText(/Fewer songs for the biggest artists/))
    await userEvent.clear(screen.getByLabelText('Songs per artist, at most'))
    await userEvent.type(screen.getByLabelText('Songs per artist, at most'), '0')
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }))
    expect(await screen.findByText('At least 1')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Songs per artist, at most'), '50')
    await userEvent.click(screen.getByRole('button', { name: 'Start import' }))
    expect(handlers.onStart).toHaveBeenCalledWith({ recordingsPerArtist: 50 })
  })
})
