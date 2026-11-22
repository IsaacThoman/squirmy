import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { artistDetail } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const id = '00000000-0000-4000-8100-000000000001'

async function renderArtist(radio: boolean | undefined, { inLibrary = false, requester = true } = {}) {
  const fake = fakeServices({ user: requester ? currentUser : { ...currentUser, role: 'member', canAcquire: false } })
  fake.api.catalog.artist.mockResolvedValue({ ...artistDetail(id)!, inLibrary, radio })
  renderWithApp(<AppRoutes />, `/artist/${id}`, fake.services)
  await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
  return screen.queryByRole('button', { name: 'Start Mira Vale radio' })
}

describe('artist radio', () => {
  it('is offered when the server says a radio starts, even with nothing in the library', async () => {
    expect(await renderArtist(true, { requester: false })).toBeInTheDocument()
  })

  it('is left out when the server says nothing plays, even for a requester', async () => {
    expect(await renderArtist(false)).toBeNull()
  })

  it('falls back to the library and the viewer for a server that does not say', async () => {
    expect(await renderArtist(undefined)).toBeInTheDocument()
  })

  it('falls back to the library for someone who may not fetch', async () => {
    expect(await renderArtist(undefined, { requester: false })).toBeNull()
  })
})
