import type { AcquisitionJob, AcquisitionPolicy, AcquisitionProvider, LibraryRoot, ServerSettings } from '@squirmy/contracts'
import { ApiError } from '@squirmy/client-core'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { serverSettings } from '@/fixtures/server'
import { root } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { ProvidersAdmin } from './ProvidersAdmin'
import { ServerSettingsAdmin } from './ServerSettingsAdmin'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const provider: AcquisitionProvider = {
  id: id(1), name: 'Shelf', baseUrl: 'http://shelf.lan:4801', enabled: true, coverage: 'assume_available', priority: 0,
  capabilities: { protocol: 1, name: 'Shelf service', coverage: 'assume_available', kinds: ['recording', 'album'], formats: ['flac'], maxConcurrent: 2 },
  lastOkAt: '2026-11-20T10:00:00.000Z', lastError: null,
}
const policy: AcquisitionPolicy = { preferLossless: true, maxFileBytes: 500 * 1024 ** 2, storageQuotaBytes: 0, timeoutSeconds: 900, targetRootId: null, deliveryBaseUrl: null }
const job: AcquisitionJob = {
  id: id(2), providerId: id(1), providerName: 'Shelf', requestedBy: 'alex', trackId: id(3), albumId: null, title: 'Low Tide — Lune Park',
  status: 'failed', error: 'The provider failed: gone', importId: null, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:01:00.000Z', completedAt: '2026-11-20T10:01:00.000Z',
}
const managed: LibraryRoot = { ...root, id: id(9), name: 'Managed', mode: 'managed' }

function renderProviders(overrides: Partial<Parameters<typeof ProvidersAdmin>[0]> = {}) {
  const props = {
    providers: [provider], policy, managedRoots: [managed], jobs: [job], jobStatus: null, onJobStatusChange: vi.fn(),
    onCreate: vi.fn(async () => provider), onUpdate: vi.fn(async () => provider), onDelete: vi.fn(async () => ({ ok: true })),
    onTest: vi.fn(async () => provider), onSavePolicy: vi.fn(async () => policy),
    ...overrides,
  }
  renderWithApp(<ProvidersAdmin {...props} />)
  return props
}

describe('providers admin', () => {
  it('adds a provider, checking the secret first', async () => {
    const props = renderProviders({ providers: [] })
    expect(screen.getByText(/On-demand fetching is off/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Add provider' })[0]!)
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Shelf')
    await userEvent.type(within(dialog).getByLabelText('Address'), 'http://shelf.lan:4801')
    await userEvent.type(within(dialog).getByLabelText('Shared secret'), 'short')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }))
    expect(within(dialog).getByText('At least 8 characters')).toBeInTheDocument()
    expect(props.onCreate).not.toHaveBeenCalled()
    await userEvent.type(within(dialog).getByLabelText('Shared secret'), ' and longer')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add provider' }))
    expect(props.onCreate).toHaveBeenCalledWith({ name: 'Shelf', baseUrl: 'http://shelf.lan:4801', secret: 'short and longer', priority: 0, enabled: true })
  })

  it('edits without touching the secret unless a new one is typed', async () => {
    const props = renderProviders()
    await userEvent.click(screen.getByRole('button', { name: 'More options for Shelf' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Shared secret')).toHaveValue('')
    await userEvent.clear(within(dialog).getByLabelText('Name'))
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Attic')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith(provider.id, { name: 'Attic', baseUrl: provider.baseUrl, priority: 0 })
  })

  it('tests the connection and shows what the provider reports, or why it failed', async () => {
    const onTest = vi.fn(async () => provider)
    renderProviders({ onTest })
    const card = screen.getByRole('listitem', { name: 'Shelf' })
    expect(within(card).getByText('Shelf service')).toBeInTheDocument()
    expect(within(card).getByText('single songs, whole albums')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Test connection' }))
    expect(await within(card).findByRole('status')).toHaveTextContent('Connected. It calls itself “Shelf service”.')
    onTest.mockResolvedValueOnce({ ...provider, lastError: 'connect ECONNREFUSED' })
    await userEvent.click(within(card).getByRole('button', { name: 'Test connection' }))
    expect(await within(card).findByText('Could not connect: connect ECONNREFUSED')).toBeInTheDocument()
  })

  it('says priced offers are ignored, and lists failed requests with their error', () => {
    renderProviders()
    expect(screen.getByText(/Offers that come with a price are ignored in this version/)).toBeInTheDocument()
    const requests = screen.getByRole('list', { name: 'Requests' })
    expect(within(requests).getByText('The provider failed: gone')).toBeInTheDocument()
    expect(within(requests).getByText('Failed')).toBeInTheDocument()
  })

  it('saves the delivery address, and empties it back to automatic', async () => {
    const props = renderProviders()
    const field = screen.getByLabelText('Delivery address')
    await userEvent.type(field, 'nonsense{Enter}')
    expect(screen.getByText('Invalid URL')).toBeInTheDocument()
    await userEvent.clear(field)
    await userEvent.type(field, 'http://squirmy:4747{Enter}')
    expect(props.onSavePolicy).toHaveBeenCalledWith({ deliveryBaseUrl: 'http://squirmy:4747' }, { inline: true })
  })
})

describe('import settings', () => {
  it('shows why the server refused an inbox folder under the field', async () => {
    const onSave = vi.fn(async () => { throw new ApiError(400, 'inbox_not_found', 'The inbox folder does not exist') })
    renderWithApp(<ServerSettingsAdmin settings={serverSettings as ServerSettings} managedRoots={[managed]} onSave={onSave} status="idle" />, '/admin/settings')
    await userEvent.click(screen.getByRole('link', { name: 'Library & imports' }))
    await userEvent.type(screen.getByLabelText('Inbox folder'), '/srv/nowhere{Enter}')
    expect(onSave).toHaveBeenCalledWith({ inboxPath: '/srv/nowhere' }, { inline: true })
    expect(await screen.findByText('The inbox folder does not exist')).toBeInTheDocument()
    expect(screen.getByLabelText('Inbox folder')).toHaveValue('/srv/nowhere')
  })
})
