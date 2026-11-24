import type { AcquisitionJob } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const job = (n: number): AcquisitionJob => ({
  id: id(n), providerId: id(900), providerName: 'Shelf', requestedBy: 'alex', trackId: id(1000 + n), albumId: null, title: `Request ${n}`,
  status: 'completed', error: null, importId: null, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:01:00.000Z', completedAt: '2026-11-20T10:01:00.000Z',
})

describe('admin pages', () => {
  it('Providers lists every request, a page at a time', async () => {
    const fake = fakeServices()
    fake.api.acquisition.jobs.mockImplementation((async (query: { cursor?: string } = {}) => (query.cursor === 'next'
      ? { items: [job(3)], nextCursor: null }
      : { items: [job(1), job(2)], nextCursor: 'next' })) as never)
    renderWithApp(<AppRoutes />, '/admin/providers', fake.services)
    const list = await screen.findByRole('list', { name: 'Requests' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Show older requests' }))
    expect(await within(list).findByText('Request 3')).toBeInTheDocument()
    expect(fake.api.acquisition.jobs).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    // The last page came: nothing older to ask for.
    expect(screen.queryByRole('button', { name: 'Show older requests' })).toBeNull()
  })

  it('a missing page names the tab after itself', async () => {
    renderWithApp(<AppRoutes />, '/nowhere')
    expect(await screen.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeInTheDocument()
    expect(document.title).toBe('Nothing here · Squirmy')
  })
})
