import type { CatalogIndexStatus, MatchCandidate, MatchFile, MatchReviewDetail, OrganizeBatch, OrganizeBatchSummary, User } from '@squirmy/contracts'
import { DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TAGS_NOT_REVERTED } from '@squirmy/contracts'
import { ApiError } from '@squirmy/client-core'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { root, templateInfo } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { LibraryAdmin } from './LibraryAdmin'
import { FixMatchView } from './FixMatchDialog'
import { CandidateComparison } from './MatchCompare'
import { OrganizeAdmin } from './OrganizeAdmin'
import { ReviewAdmin } from './ReviewAdmin'
import { SearchIndexAdmin } from './SearchIndexAdmin'
import { UsersAdmin } from './UsersAdmin'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ok = () => vi.fn(async () => ({ ok: true }))
const refused = (message: string) => vi.fn(async () => { throw new ApiError(409, 'conflict', message) })

function renderLibrary(overrides: Partial<Parameters<typeof LibraryAdmin>[0]> = {}) {
  const props = {
    roots: [root], stats: undefined, openReviews: 0, progress: {}, templateInfo,
    folders: { path: '/srv', listing: { path: '/srv', parent: '/', directories: [] }, error: undefined, onBrowse: vi.fn() },
    onScan: vi.fn(async () => ({ queued: true })), onAdd: ok(), onUpdate: ok(), onRemove: ok(), onFixMatch: vi.fn(),
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

  it('says on the folder\'s row when a scan is already running, and nothing when one starts', async () => {
    const onScan = vi.fn(async () => ({ queued: true }))
    renderLibrary({ onScan })
    const row = screen.getByRole('listitem', { name: 'Music' })
    await userEvent.click(within(row).getByRole('button', { name: 'Scan now' }))
    expect(onScan).toHaveBeenCalledWith(root.id)
    expect(within(row).getByRole('status')).toBeEmptyDOMElement()
    onScan.mockResolvedValueOnce({ queued: false })
    await userEvent.click(within(row).getByRole('button', { name: 'Scan now' }))
    expect(await within(row).findByRole('status')).toHaveTextContent('Already scanning. The folder is scanned again once this scan finishes.')
  })

  it('says why a folder could not be disabled on its row', async () => {
    renderLibrary({ onUpdate: refused('The folder is busy') })
    await userEvent.click(screen.getByRole('button', { name: 'More options for Music' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Disable' }))
    const row = screen.getByRole('listitem', { name: 'Music' })
    expect(await within(row).findByText('The folder is busy')).toBeInTheDocument()
  })

  it('says why a folder could not be removed in the confirmation, and keeps it open', async () => {
    renderLibrary({ onRemove: refused('A scan is running') })
    await userEvent.click(screen.getByRole('button', { name: 'More options for Music' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove folder…' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove folder' }))
    expect(await within(dialog).findByText('A scan is running')).toBeInTheDocument()
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

  it('says under the preview why it could not be applied', async () => {
    renderWithApp(<OrganizeAdmin {...props()} onApply={refused('Another batch is running in this folder')} />)
    await userEvent.click(screen.getByRole('button', { name: 'Apply all' }))
    const panel = screen.getByRole('region', { name: 'Preview' })
    expect(await within(panel).findByText('Another batch is running in this folder')).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Apply all' })).toBeEnabled()
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
      rowsRead: 1_200_000, error: null, resumes: 0, resumedAt: null, startedAt: '2026-11-20T10:00:00.000Z', finishedAt: null,
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

  it('says when an import is waiting to resume after a restart, and when it has', () => {
    const handlers = { onStart: ok(), onCancel: ok(), onRemove: ok() }
    const { rerender } = renderWithApp(<SearchIndexAdmin status={{ ...status, latest: { ...status.latest!, state: 'interrupted' } }} starting={false} {...handlers} />)
    const panel = screen.getByRole('region', { name: 'Import in progress' })
    expect(panel).toHaveTextContent('Waiting to resume')
    expect(panel).toHaveTextContent('The server restarted. The import carries on from where it stopped in a moment.')
    // Still under way: no second import can be started, and it can be cancelled.
    expect(screen.queryByRole('button', { name: 'Import again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

    const resumed = { ...status.latest!, resumes: 1, resumedAt: '2026-11-20T10:05:00.000Z' }
    rerender(<SearchIndexAdmin status={{ ...status, latest: resumed }} starting={false} {...handlers} />)
    expect(screen.getByRole('region', { name: 'Import in progress' })).toHaveTextContent('Resumed after a restart')
    expect(screen.queryByText('Waiting to resume')).toBeNull()

    rerender(<SearchIndexAdmin status={{ ...status, active: { ...resumed, state: 'active', resumes: 2 }, latest: null }} starting={false} {...handlers} />)
    expect(screen.getByText(/imported .* \(resumed after 2 restarts\)\./)).toBeInTheDocument()
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

describe('review queue', () => {
  const review: MatchReviewDetail = {
    id: id(40), rootId: root.id, groupKey: 'okc', albumId: id(41), status: 'open', bestScore: 0.6, candidateCount: 0, createdAt: '2026-11-20T10:00:00.000Z', resolvedAt: null,
    summary: { artist: 'Radiohead', album: 'OK Computer', year: 1997, folder: 'okc', trackCount: 2 },
    candidates: [], files: [],
  }

  it('says what was decided once the next album takes its place, and why it was not', async () => {
    const onResolve = vi.fn(async () => ({ ok: true }))
    const { rerender } = renderWithApp(<ReviewAdmin status="open" onStatusChange={vi.fn()} reviews={[review]} rootNames={{}} selectedId={review.id} onSelect={vi.fn()} detail={review} onResolve={onResolve} onSearch={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Keep as it is' }))
    expect(onResolve).toHaveBeenCalledWith(review, { action: 'keep_local' })
    expect(await screen.findByText('Kept “OK Computer” as tagged.')).toBeInTheDocument()
    rerender(<ReviewAdmin status="open" onStatusChange={vi.fn()} reviews={[review]} rootNames={{}} selectedId={review.id} onSelect={vi.fn()} detail={review} onResolve={refused('The review was already closed')} onSearch={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText('The review was already closed')).toBeInTheDocument()
  })
})

describe('fix match', () => {
  it('says what a choice did and offers only Done', async () => {
    const onOpenChange = vi.fn()
    renderWithApp(<FixMatchView album={undefined} files={[]} candidates={[]} searching={false} searchError={undefined} actionError={undefined} pending={null} done="Matching again. The matcher looks at the album again in the background." onSearch={vi.fn()} onAction={vi.fn()} onOpenChange={onOpenChange} />)
    expect(screen.getByText('Matching again. The matcher looks at the album again in the background.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use this release' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says why the album did not load where it would be', () => {
    renderWithApp(<FixMatchView album={undefined} albumError="The album is gone" files={undefined} candidates={undefined} searching={false} searchError={undefined} actionError={undefined} pending={null} onSearch={vi.fn()} onAction={vi.fn()} onOpenChange={vi.fn()} />)
    expect(screen.getByText('The album is gone')).toBeInTheDocument()
  })
})

describe('users admin', () => {
  const user: User = {
    id: id(50), username: 'sam', displayName: 'Sam', role: 'member', disabled: true, canUpload: false, canAcquire: false, createdAt: '2026-11-01T10:00:00.000Z',
  } as User
  const render = (onUpdateUser: (userId: string, patch: object) => Promise<unknown>) => renderWithApp(
    <UsersAdmin users={[user]} invites={[]} currentUserId={id(51)} inviteLink={() => ''} onCreateUser={ok()} onUpdateUser={onUpdateUser} onDeleteUser={ok()} onCreateInvite={vi.fn()} onRevokeInvite={ok()} />,
  )

  it('says on the user\'s row why the account could not be enabled', async () => {
    render(refused('The account is locked'))
    await userEvent.click(screen.getByRole('button', { name: 'Manage sam' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Enable account' }))
    const row = screen.getByText('@sam').closest('tr')!
    expect(await within(row).findByText('The account is locked')).toBeInTheDocument()
  })

  it('says on the user\'s row that a new password was set', async () => {
    const onUpdateUser = vi.fn(async () => user)
    render(onUpdateUser)
    await userEvent.click(screen.getByRole('button', { name: 'Manage sam' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset password…' }))
    await userEvent.type(await screen.findByLabelText('New password'), 'a long new password')
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }))
    expect(onUpdateUser).toHaveBeenCalledWith(user.id, { password: 'a long new password' })
    const row = screen.getByText('@sam').closest('tr')!
    expect(await within(row).findByText('Password changed. They were signed out everywhere.')).toBeInTheDocument()
  })
})
